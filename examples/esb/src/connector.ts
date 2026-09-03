import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  badRequest,
  CONNECTOR_LIMITS,
  unknownEntity,
  unsupported,
  type AtlasType,
  type CheckRequest,
  type CountRequest,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type NativeQueryRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { ATLAS_JSON } from "./capability";
import { ESB_CORE_CATALOG } from "./catalog";
import {
  discoveryWarning,
  isOmittableDiscoveryError,
  mapConcurrent,
  PROBE_CONCURRENCY,
  toDiscoveredTable,
  toInaccessibleVerdict,
  type AvailabilityVerdict,
} from "./helpers/discovery";
import {
  collectNeededColumns,
  projectRows,
  sortRows,
  type QueryShape,
} from "./helpers/query";
import { EsbFilterSet } from "./schemas";
import type { EsbCoreObject } from "./types";
import { EsbCoreApi, makeDeadline, type Deadline } from "./esb-api";

const PAGE_SIZE = 100;
const MAX_PAGES = 20_000;

export class EsbCoreConnector extends AtlasConnector {
  readonly slug = "esb-core";
  private readonly objectsByName = new Map(ESB_CORE_CATALOG.map((object) => [object.name, object]));

  capability() {
    return ATLAS_JSON;
  }

  async check(req: CheckRequest): Promise<void> {
    await new EsbCoreApi(req.credentials).authenticate(makeDeadline(req.timeoutMs));
  }

  private objectFor(table: string): EsbCoreObject {
    const object = this.objectsByName.get(table);
    if (!object) throw unknownEntity(`unknown table "${table}"`);
    return object;
  }

  private validate(req: QueryShape, object: EsbCoreObject): ReadonlyMap<string, AtlasType> {
    if (req.joins && req.joins.length > 0) throw unsupported("joins are not supported; Atlas joins locally");
    const fieldTypes = new Map(object.columns.map((column) => [column.name, column.type]));
    assertKnownFields(req, fieldTypes.keys());
    for (const field of req.fields) {
      if (!fieldTypes.has(field)) throw unsupported(`unknown requested field '${field}' on ${object.name}`);
    }
    for (const sort of req.sort ?? []) {
      if (!fieldTypes.has(sort.field)) throw unsupported(`unknown sort field '${sort.field}' on ${object.name}`);
    }
    if (object.primaryKey && !fieldTypes.has(object.primaryKey)) {
      throw new Error(`esb-core: declared primary key ${object.name}.${object.primaryKey} is not a catalog field`);
    }
    return fieldTypes;
  }

  private async *scan(
    api: EsbCoreApi,
    req: QueryShape,
    deadline: Deadline,
  ): AsyncIterable<SourceRow[]> {
    const object = this.objectFor(req.table);
    this.validate(req, object);
    const fields = [...collectNeededColumns(req, object)];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      deadline.check();
      const result = await api.collection(object, page, PAGE_SIZE, deadline, fields);
      const rows = projectRows(result.rows, fields);
      for (let index = 0; index < rows.length; index += CONNECTOR_LIMITS.rowsPerBatch) {
        deadline.check();
        yield rows.slice(index, index + CONNECTOR_LIMITS.rowsPerBatch);
      }
      if (object.mode === "direct" || !result.hasNext) return;
    }
    throw new Error(`esb-core: ${object.name} exceeded ${MAX_PAGES} pages; the page walk would be truncated`);
  }

  private async *scanFiltered(
    api: EsbCoreApi,
    req: QueryShape,
    deadline: Deadline,
  ): AsyncIterable<SourceRow[]> {
    const object = this.objectFor(req.table);
    const fieldTypes = Object.fromEntries(object.columns.map((column) => [column.name, column.type]));
    const parsedFilters = EsbFilterSet(fieldTypes).safeParse({ and: req.and, or: req.or });
    if (!parsedFilters.success) throw badRequest("filter values do not match the ESB Core catalog types");
    for await (const batch of this.scan(api, req, deadline)) {
      deadline.check();
      const filtered = applyFilters(batch, parsedFilters.data, fieldTypes);
      deadline.check();
      yield filtered;
    }
  }

  async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    const api = new EsbCoreApi(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const offset = req.offset ?? 0;
    if (req.sort.length > 0 || offset > 0) {
      const rows: SourceRow[] = [];
      for await (const batch of this.scanFiltered(api, req, deadline)) rows.push(...batch);
      deadline.check();
      const object = this.objectFor(req.table);
      const fieldTypes = new Map(object.columns.map((column) => [column.name, column.type]));
      sortRows(rows, req.sort, fieldTypes);
      const end = req.limit === undefined ? undefined : offset + req.limit;
      const window = rows.slice(offset, end);
      for (let index = 0; index < window.length; index += CONNECTOR_LIMITS.rowsPerBatch) {
        deadline.check();
        yield projectRows(window.slice(index, index + CONNECTOR_LIMITS.rowsPerBatch), req.fields);
      }
      return;
    }

    let remaining = req.limit ?? Number.POSITIVE_INFINITY;
    for await (const batch of this.scanFiltered(api, req, deadline)) {
      const capped = batch.length > remaining ? batch.slice(0, remaining) : batch;
      remaining -= capped.length;
      if (capped.length > 0) yield projectRows(capped, req.fields);
      if (remaining <= 0) return;
    }
  }

  async count(req: CountRequest): Promise<number> {
    const api = new EsbCoreApi(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const shape: QueryShape = {
      table: req.table,
      and: req.and,
      or: req.or,
      fields: [],
    };
    let count = 0;
    for await (const batch of this.scanFiltered(api, shape, deadline)) count += batch.length;
    return count;
  }

  async discover(req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    const api = new EsbCoreApi(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    await api.authenticate(deadline);

    const verdicts = new Map<EsbCoreObject, AvailabilityVerdict>();
    let fatal: unknown;
    const probe = async (object: EsbCoreObject): Promise<void> => {
      if (fatal !== undefined) throw fatal;
      try {
        await api.collection(object, 1, 1, deadline);
        verdicts.set(object, { object, accessible: true });
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
    const objects = ordered.flatMap((verdict) => (verdict.accessible ? [verdict.object] : []));
    if (objects.length === 0) throw new Error("esb-core: no readable collection endpoints were discovered");
    const warnings = ordered.flatMap((verdict) => {
      const warning = discoveryWarning(verdict);
      return warning ? [warning] : [];
    });
    return {
      tables: objects.map(toDiscoveredTable),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
