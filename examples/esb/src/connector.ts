import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  badRequest,
  CONNECTOR_LIMITS,
  unknownEntity,
  unsupported,
  type AtlasType,
  type AtlasValue,
  type CheckRequest,
  type CountRequest,
  type DiscoveredField,
  type DiscoveredTable,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type Filter,
  type NativeQueryRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { ATLAS_JSON } from "./capability";
import { ESB_CORE_CATALOG } from "./catalog";
import { EsbFilterSet } from "./schemas";
import type { EsbCoreObject } from "./types";
import {
  EsbCoreApi,
  EsbCoreError,
  makeDeadline,
  type Deadline,
} from "./esb-api";

const PAGE_SIZE = 100;
const MAX_PAGES = 20_000;
const PROBE_CONCURRENCY = 4;
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

type QueryShape = {
  table: string;
  and: Filter[];
  or?: Filter[][];
  fields: string[];
  sort?: Array<{ field: string; dir: "asc" | "desc" }>;
  joins?: unknown[];
};

type AvailabilityVerdict =
  | { object: EsbCoreObject; accessible: true }
  | {
      object: EsbCoreObject;
      accessible: false;
      reason: "permission" | "unavailable" | "rejected" | "incompatible";
      status: number;
      code: string;
    };

type Decimal = { negative: boolean; int: string; frac: string };
const DECIMAL_TEXT = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function byteOrderCompare(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length) {
    const left = a.codePointAt(index) as number;
    const right = b.codePointAt(index) as number;
    if (left !== right) return left < right ? -1 : 1;
    index += left > 0xffff ? 2 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function parseDecimal(text: string): Decimal | null {
  const match = DECIMAL_TEXT.exec(text);
  if (!match) return null;
  const int = (match[2] as string).replace(/^0+(?=\d)/, "");
  const frac = (match[3] ?? "").replace(/0+$/, "");
  const negative = match[1] === "-" && !(int === "0" && frac === "");
  return { negative, int, frac };
}

function decimalCompare(a: string, b: string): number | null {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  if (!left || !right) return null;
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const flip = left.negative ? -1 : 1;
  if (left.int.length !== right.int.length) return (left.int.length < right.int.length ? -1 : 1) * flip;
  if (left.int !== right.int) return (left.int < right.int ? -1 : 1) * flip;
  if (left.frac === right.frac) return 0;
  return (left.frac < right.frac ? -1 : 1) * flip;
}

function compareCells(a: AtlasValue, b: AtlasValue, type: AtlasType): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (type === "number" || type === "decimal") {
    return decimalCompare(String(a), String(b)) ?? byteOrderCompare(String(a), String(b));
  }
  return byteOrderCompare(String(a), String(b));
}

function sortRows(
  rows: SourceRow[],
  sort: Array<{ field: string; dir: "asc" | "desc" }>,
  fieldTypes: ReadonlyMap<string, AtlasType>,
): void {
  rows.sort((a, b) => {
    for (const key of sort) {
      const left = a[key.field] ?? null;
      const right = b[key.field] ?? null;
      if (left === null || right === null) {
        if (left === null && right === null) continue;
        return left === null ? 1 : -1;
      }
      const order = compareCells(left, right, fieldTypes.get(key.field) ?? "string");
      if (order !== 0) return key.dir === "desc" ? -order : order;
    }
    return 0;
  });
}

function neededColumns(req: QueryShape, object: EsbCoreObject): Set<string> {
  const fields = new Set(req.fields);
  for (const filter of req.and) fields.add(filter.field);
  for (const group of req.or ?? []) for (const filter of group) fields.add(filter.field);
  for (const sort of req.sort ?? []) fields.add(sort.field);
  if (object.primaryKey) fields.add(object.primaryKey);
  return fields;
}

function project(rows: SourceRow[], fields: string[]): SourceRow[] {
  return rows.map((row) => {
    const selected: SourceRow = {};
    for (const field of fields) selected[field] = row[field] ?? null;
    return selected;
  });
}

function omittable(error: unknown): error is EsbCoreError & { status: number } {
  if (!(error instanceof EsbCoreError) || error.credentialFailure || error.failureKind === "authentication") {
    return false;
  }
  const status = error.status;
  if (status === undefined) return false;
  if (error.failureKind === "permission") return true;
  if (error.applicationFailure || TRANSIENT_STATUSES.has(status) || status >= 500) return false;
  const incompatible = error.code === "malformed-response" || error.code === "non-progressing-page";
  return (incompatible && status >= 200 && status < 300) || (status >= 400 && status < 500);
}

function inaccessibleVerdict(object: EsbCoreObject, error: EsbCoreError & { status: number }): AvailabilityVerdict {
  const incompatible = error.code === "malformed-response" || error.code === "non-progressing-page";
  return {
    object,
    accessible: false,
    reason: incompatible
      ? "incompatible"
      : error.failureKind === "permission" || error.status === 403
        ? "permission"
        : error.status === 404
          ? "unavailable"
          : "rejected",
    status: error.status,
    code: error.code,
  };
}

function warningFor(verdict: AvailabilityVerdict): string | null {
  if (verdict.accessible) return null;
  return verdict.reason === "incompatible"
    ? `ESB Core ${verdict.object.name} (${verdict.object.path}) was omitted: response format is not supported by Atlas`
    : `ESB Core ${verdict.object.name} (${verdict.object.path}) was omitted: HTTP ${verdict.status}, code ${verdict.code}`;
}

async function mapConcurrent<T>(values: T[], concurrency: number, visit: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await visit(values[index] as T);
    }
  });
  await Promise.all(workers);
}

function discoveredTable(object: EsbCoreObject): DiscoveredTable {
  const fields: DiscoveredField[] = object.columns.map((column) => ({
    name: column.name,
    sourceColumn: column.name,
    type: column.type,
    nullable: column.nullable,
    unique: object.primaryKey === column.name,
    samples: [],
    sourceDescription: column.description,
  }));
  return {
    name: object.name,
    sourceDescription: object.description,
    storesRows: true,
    primaryKey: object.primaryKey ? [object.primaryKey] : [],
    foreignKeys: [],
    fields,
  };
}

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
    const fields = [...neededColumns(req, object)];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      deadline.check();
      const result = await api.collection(object, page, PAGE_SIZE, deadline, fields);
      const rows = project(result.rows, fields);
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
        yield project(window.slice(index, index + CONNECTOR_LIMITS.rowsPerBatch), req.fields);
      }
      return;
    }

    let remaining = req.limit ?? Number.POSITIVE_INFINITY;
    for await (const batch of this.scanFiltered(api, req, deadline)) {
      const capped = batch.length > remaining ? batch.slice(0, remaining) : batch;
      remaining -= capped.length;
      if (capped.length > 0) yield project(capped, req.fields);
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
        if (omittable(error)) {
          verdicts.set(object, inaccessibleVerdict(object, error));
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
      const warning = warningFor(verdict);
      return warning ? [warning] : [];
    });
    return {
      tables: objects.map(discoveredTable),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
