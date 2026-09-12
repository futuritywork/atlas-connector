import {
  assertKnownFields,
  AtlasConnector,
  CONNECTOR_LIMITS,
  defineCatalog,
  unknownEntity,
  unsupported,
  windowRows,
  type CheckRequest,
  type CountRequest,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type EntitySize,
  type NativeQueryRequest,
  type QueryChunk,
  type SizeRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { CAPABILITY } from "./capability";
import { ESB_CORE_CATALOG } from "./catalog";
import { EsbCoreApi, makeDeadline, type Deadline } from "./esb-api";
import {
  discoveryWarning,
  isOmittableDiscoveryError,
  mapConcurrent,
  PROBE_CONCURRENCY,
  toDiscoveredTable,
  toInaccessibleVerdict,
  type AvailabilityVerdict,
} from "./helpers/discovery";
import { controlFilters, honoredFilters, rememberHonoredFilters } from "./helpers/negative-control";
import { planQuery, type QueryPlan } from "./helpers/pushdown";
import type { EsbCoreObject } from "./types";

const PAGE_SIZE = 1_000;
const MAX_PAGES = 20_000;

type PageJump = { firstPage: number; drop: number }; // drop = rows of firstPage the offset already consumed

function projectRows(rows: SourceRow[], fields: string[]): SourceRow[] {
  return rows.map((row) => {
    const selected: SourceRow = {};
    for (const field of fields) selected[field] = row[field] ?? null;
    return selected;
  });
}

// only an exactly-answered request may read just its window
function pageSizeFor(object: EsbCoreObject, req: NativeQueryRequest, windowed: boolean): number {
  const full = object.pageSize ?? PAGE_SIZE;
  if (!windowed || req.limit === undefined) return full;
  return Math.min(full, (req.offset ?? 0) + req.limit);
}

function pageJumpFor(req: NativeQueryRequest, pageSize: number): PageJump {
  const offset = req.offset ?? 0;
  return { firstPage: Math.floor(offset / pageSize) + 1, drop: offset % pageSize };
}

export class EsbCoreConnector extends AtlasConnector {
  readonly slug = "esb-core";
  private readonly catalog = defineCatalog(ESB_CORE_CATALOG);

  capabilities() {
    return CAPABILITY;
  }

  async check(req: CheckRequest): Promise<void> {
    await new EsbCoreApi(req.credentials).authenticate(makeDeadline(req.timeoutMs));
  }

  private objectFor(table: string): EsbCoreObject {
    const object = this.catalog.getTable(table);
    if (!object) throw unknownEntity(`unknown table "${table}"`);
    return object;
  }

  private async *walk(
    api: EsbCoreApi,
    object: EsbCoreObject,
    request: { plan: QueryPlan; fields: string[]; pageSize: number; jump: PageJump },
    deadline: Deadline,
  ): AsyncIterable<SourceRow[]> {
    const { plan, fields, pageSize, jump } = request;
    let drop = jump.drop;
    for (let walked = 0; walked < MAX_PAGES; walked += 1) {
      deadline.check();
      const result = await api.collection(
        object,
        { page: jump.firstPage + walked, limit: pageSize, params: plan.params, fields },
        deadline,
      );
      const rows = projectRows(result.rows, fields).slice(drop);
      drop = 0;
      for (let index = 0; index < rows.length; index += CONNECTOR_LIMITS.rowsPerBatch) {
        deadline.check();
        yield rows.slice(index, index + CONNECTOR_LIMITS.rowsPerBatch);
      }
      if (object.mode === "direct" || !result.hasNext) return;
    }
    throw new Error(`esb-core: ${object.name} exceeded ${MAX_PAGES} pages; the page walk would be truncated`);
  }

  // an unmapped field, an or-group, a substring param or an unsortable column leaves a superset
  async *query(req: NativeQueryRequest): AsyncIterable<QueryChunk> {
    const object = this.objectFor(req.table);
    if (req.joins && req.joins.length > 0) throw unsupported("joins are not supported; Atlas joins locally");
    const needed = assertKnownFields(req, object.columns.map((column) => column.name));
    if (object.primaryKey) needed.add(object.primaryKey);

    const api = new EsbCoreApi(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const plan = planQuery(object, req, honoredFilters(req.credentials));
    yield { served: plan.served };

    const pageSize = pageSizeFor(object, req, plan.served.window);
    // only a numbered page can be jumped to
    const jumped = plan.served.window && object.mode === "paged";
    const jump = jumped ? pageJumpFor(req, pageSize) : { firstPage: 1, drop: 0 };
    const pages = this.walk(api, object, { plan, fields: [...needed], pageSize, jump }, deadline);

    const offset = jumped ? 0 : req.offset;
    const windowed = plan.served.window ? windowRows(pages, { offset, limit: req.limit }) : pages;
    for await (const batch of windowed) {
      deadline.check();
      yield projectRows(batch, req.fields);
    }
  }

  // `count` on a paged response is the whole filtered collection, so limit=1 answers it
  override async count(req: CountRequest): Promise<number> {
    const object = this.objectFor(req.table);
    assertKnownFields(req, object.columns.map((column) => column.name));
    const plan = planQuery(object, { ...req, sort: [] }, honoredFilters(req.credentials));
    if (!plan.served.filters) throw unsupported(`esb-core: ${object.name} cannot count this filter upstream`);

    const api = new EsbCoreApi(req.credentials);
    const head = await api.collection(
      object,
      { page: 1, limit: 1, params: plan.params, fields: [] },
      makeDeadline(req.timeoutMs),
    );
    if (object.mode === "direct") return head.rows.length;
    if (head.count === undefined) throw unsupported(`esb-core: ${object.name} answered without a count`);
    return head.count;
  }

  override async size(req: SizeRequest): Promise<EntitySize | null> {
    const object = this.objectFor(req.table);
    const api = new EsbCoreApi(req.credentials);
    const head = await api.collection(object, { page: 1, limit: 1, fields: [] }, makeDeadline(req.timeoutMs));
    if (object.mode === "direct") return { rows: head.rows.length, exact: true };
    return head.count === undefined ? null : { rows: head.count, exact: true };
  }

  async discovery(req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    const api = new EsbCoreApi(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    await api.authenticate(deadline);

    const verdicts = new Map<EsbCoreObject, AvailabilityVerdict>();
    let fatal: unknown;
    const probe = async (object: EsbCoreObject): Promise<void> => {
      if (fatal !== undefined) throw fatal;
      try {
        // the availability probe doubles as the row count
        const head = await api.collection(object, { page: 1, limit: 1 }, deadline);
        const rowCount = object.mode === "direct" ? head.rows.length : head.count;
        verdicts.set(object, { object, accessible: true, ...(rowCount === undefined ? {} : { rowCount }) });
      } catch (error) {
        if (isOmittableDiscoveryError(error)) {
          verdicts.set(object, toInaccessibleVerdict(object, error));
          return;
        }
        fatal = error;
        throw error;
      }
    };

    await mapConcurrent(
      ESB_CORE_CATALOG.filter((object) => object.mode === "paged"),
      PROBE_CONCURRENCY,
      probe,
    );
    for (const object of ESB_CORE_CATALOG) {
      if (object.mode === "direct") await probe(object);
    }

    const ordered = ESB_CORE_CATALOG.map((object) => {
      const verdict = verdicts.get(object);
      if (!verdict) throw new Error(`esb-core: availability probe produced no verdict for ${object.name}`);
      return verdict;
    });
    const available = ordered.flatMap((verdict) => (verdict.accessible ? [verdict] : []));
    if (available.length === 0) throw new Error("esb-core: no readable collection endpoints were discovered");

    const ignored = await controlFilters(api, available, PROBE_CONCURRENCY, deadline);
    rememberHonoredFilters(req.credentials, available, ignored);
    const warnings = [
      ...ordered.flatMap((verdict) => {
        const warning = discoveryWarning(verdict);
        return warning ? [warning] : [];
      }),
      ...ignored.map((entry) => entry.warning),
    ];
    return {
      tables: available.map((verdict) => toDiscoveredTable(verdict.object, verdict.rowCount)),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
