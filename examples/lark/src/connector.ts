// lark base (bitable) → atlas: tables → atlas tables, fields → columns, records/search → rows.
// the tenant's app credentials and app_token arrive on every request, so one process serves any number of bases and keeps none of them.
// lark evaluates the pushable slice of a filter; applyFilters re-runs the full set, so every advertised op holds.

import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  byteOrderCompare,
  CONNECTOR_LIMITS,
  discoverFields,
  field,
  fieldTypes,
  unknownEntity,
  unsupported,
  type AtlasType,
  type AtlasValue,
  type CheckRequest,
  type CountExactRequest,
  type CountRequest,
  type Credentials,
  type DiscoveredTable,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type NativeQueryRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { ATLAS_JSON } from "./capability";
import { atlasTypeOf, flattenValue, LARK_TYPE } from "./field-map";
import {
  LarkClient,
  larkCredentials,
  makeDeadline,
  type Deadline,
  type LarkField,
  type LarkRecord,
  type LarkTable,
} from "./lark-api";
import { pushdownConditions } from "./pushdown";

const RECORD_ID = "record_id";
const META_CACHE_MS = 60_000;
const SAMPLE_PAGE_SIZE = 20;
const SAMPLES_PER_FIELD = 5;

// the slice of a wire request the scan helpers read
type QueryShape = Pick<NativeQueryRequest, "table" | "and" | "or" | "fields"> &
  Partial<Pick<NativeQueryRequest, "sort" | "joins">>;

// one base's metadata, expiring as a unit
type BaseMeta = {
  at: number;
  tables: Map<string, LarkTable>;
  fields: Map<string, Map<string, LarkField>>;
};

function clientFor(credentials: Credentials): LarkClient {
  return new LarkClient(larkCredentials(credentials));
}

function catalogFields(fieldsByName: Map<string, LarkField>) {
  return [
    field(RECORD_ID, "string", { unique: true, description: "lark record id (system primary key)" }),
    ...[...fieldsByName.values()]
      .filter((source) => source.field_name !== RECORD_ID)
      .map((source) => field(source.field_name, atlasTypeOf(source), {
        nullable: true,
        description: `lark ${source.ui_type ?? `type ${source.type}`}`,
      })),
  ];
}

function neededColumns(req: QueryShape): Set<string> {
  const needed = new Set(req.fields);
  for (const filter of req.and) needed.add(filter.field);
  for (const group of req.or ?? []) for (const filter of group) needed.add(filter.field);
  for (const sort of req.sort ?? []) needed.add(sort.field);
  return needed;
}

function toRow(record: LarkRecord, columns: Iterable<string>, fieldsByName: Map<string, LarkField>): SourceRow {
  const row: SourceRow = {};
  for (const column of columns) {
    if (column === RECORD_ID) {
      row[column] = record.record_id;
      continue;
    }
    const meta = fieldsByName.get(column);
    row[column] = meta ? flattenValue(record.fields[column], meta.type) : null;
  }
  return row;
}

function compareCell(a: Exclude<AtlasValue, null>, b: Exclude<AtlasValue, null>, type: AtlasType | undefined): number {
  if (type === "number" || type === "decimal") {
    const left = Number(a);
    const right = Number(b);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    }
  }
  return byteOrderCompare(String(a), String(b));
}

function sortRows(rows: SourceRow[], sort: NativeQueryRequest["sort"], types: Record<string, AtlasType>): void {
  rows.sort((a, b) => {
    for (const key of sort) {
      const left = a[key.field];
      const right = b[key.field];
      if (left === null || right === null) {
        if (left === null && right === null) continue;
        return left === null ? 1 : -1;
      }
      const order = compareCell(left, right, types[key.field]);
      if (order !== 0) return key.dir === "desc" ? -order : order;
    }
    return 0;
  });
}

function project(rows: SourceRow[], fields: string[]): SourceRow[] {
  return rows.map((row) => {
    const out: SourceRow = {};
    for (const field of fields) out[field] = row[field];
    return out;
  });
}

export class LarkConnector extends AtlasConnector {
  readonly slug = "lark-base";

  // keyed by credential set: one tenant must never read tables from another's cache
  private readonly metaByCredential = new Map<string, BaseMeta>();

  capability() {
    return ATLAS_JSON;
  }

  async check(req: CheckRequest): Promise<void> {
    await clientFor(req.credentials).checkAccess(makeDeadline(req.timeoutMs));
  }

  // #region metadata

  private async meta(client: LarkClient, deadline: Deadline): Promise<BaseMeta> {
    const cached = this.metaByCredential.get(client.cacheKey);
    if (cached && Date.now() - cached.at < META_CACHE_MS) return cached;
    const tables = new Map((await client.listTables(deadline)).map((table) => [table.name, table]));
    const now = Date.now();
    // swept here, or expired entries never leave
    for (const [key, entry] of this.metaByCredential) {
      if (now - entry.at >= META_CACHE_MS) this.metaByCredential.delete(key);
    }
    const fresh: BaseMeta = { at: now, tables, fields: new Map() };
    this.metaByCredential.set(client.cacheKey, fresh);
    return fresh;
  }

  private async resolveTable(
    client: LarkClient,
    name: string,
    deadline: Deadline,
  ): Promise<{ meta: BaseMeta; table: LarkTable }> {
    const meta = await this.meta(client, deadline);
    const table = meta.tables.get(name);
    if (!table) throw unknownEntity(`unknown table "${name}"`);
    return { meta, table };
  }

  private async fields(
    client: LarkClient,
    meta: BaseMeta,
    tableId: string,
    deadline: Deadline,
  ): Promise<Map<string, LarkField>> {
    const cached = meta.fields.get(tableId);
    if (cached) return cached;
    const byName = new Map((await client.listFields(tableId, deadline)).map((field) => [field.field_name, field]));
    meta.fields.set(tableId, byName);
    return byName;
  }

  // #endregion

  // #region row production

  // pushes the pushable slice of and[]; rows carry exactly the needed columns
  private async *scan(
    client: LarkClient,
    req: QueryShape,
    deadline: Deadline,
    tableId: string,
    sourceFields: Map<string, LarkField>,
  ): AsyncIterable<SourceRow[]> {
    if (req.joins && req.joins.length > 0) throw unsupported("joins are not supported; atlas joins locally");
    const fieldsByName = new Map(sourceFields);
    fieldsByName.delete(RECORD_ID);
    const types = fieldTypes(catalogFields(fieldsByName));
    assertKnownFields(req, [RECORD_ID, ...fieldsByName.keys()]);
    const columns = neededColumns(req);
    const realFields = [...columns].filter((column) => fieldsByName.has(column));
    const batches = client.searchAll(tableId, deadline, {
      // field_names must name real fields; record_id rides along on every record anyway
      fieldNames: realFields.length > 0 ? realFields : undefined,
      conditions: pushdownConditions(req.and, fieldsByName),
    });
    for await (const records of batches) {
      const rows = records.map((record) => toRow(record, columns, fieldsByName));
      yield applyFilters(rows, { and: req.and, or: req.or }, types);
    }
  }

  // #endregion

  // #region protocol

  async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    const client = clientFor(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const { meta, table } = await this.resolveTable(client, req.table, deadline);
    const fieldsByName = await this.fields(client, meta, table.table_id, deadline);
    const offset = req.offset ?? 0;
    // sort and offset need the whole result before the first row can leave
    if (req.sort.length > 0 || offset > 0) {
      const rows: SourceRow[] = [];
      for await (const batch of this.scan(client, req, deadline, table.table_id, fieldsByName)) rows.push(...batch);
      sortRows(rows, req.sort, fieldTypes(catalogFields(fieldsByName)));
      const end = req.limit !== undefined ? offset + req.limit : undefined;
      const window = rows.slice(offset, end);
      for (let i = 0; i < window.length; i += CONNECTOR_LIMITS.rowsPerBatch) {
        yield project(window.slice(i, i + CONNECTOR_LIMITS.rowsPerBatch), req.fields);
      }
      return;
    }
    let remaining = req.limit ?? Number.POSITIVE_INFINITY;
    for await (const kept of this.scan(client, req, deadline, table.table_id, fieldsByName)) {
      const capped = kept.length > remaining ? kept.slice(0, remaining) : kept;
      remaining -= capped.length;
      if (capped.length > 0) yield project(capped, req.fields);
      if (remaining <= 0) return;
    }
  }

  async count(req: CountRequest): Promise<number> {
    const client = clientFor(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const { meta, table } = await this.resolveTable(client, req.table, deadline);
    const fieldsByName = await this.fields(client, meta, table.table_id, deadline);
    // scan-and-tally: lark's filtered total is untested against the residual filters
    const shape: QueryShape = {
      table: req.table,
      and: req.and,
      or: req.or,
      fields: [],
    };
    let count = 0;
    for await (const batch of this.scan(client, shape, deadline, table.table_id, fieldsByName)) count += batch.length;
    return count;
  }

  // every search page carries the table's total
  override async exactCount(req: CountExactRequest): Promise<number | null> {
    const client = clientFor(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const { table } = await this.resolveTable(client, req.table, deadline);
    return await client.recordTotal(table.table_id, deadline);
  }

  async discover(req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    const client = clientFor(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const meta = await this.meta(client, deadline);
    const idToName = new Map([...meta.tables.values()].map((table) => [table.table_id, table.name]));
    const answers: DiscoveredTable[] = [];
    const warnings: string[] = [];

    for (const table of meta.tables.values()) {
      const fieldsByName = await this.fields(client, meta, table.table_id, deadline);
      if (fieldsByName.has(RECORD_ID)) {
        warnings.push(`table "${table.name}" has a field literally named record_id; the lark record id shadows it`);
      }
      const samplePage = await client.searchPage(table.table_id, deadline, { pageSize: SAMPLE_PAGE_SIZE });
      const records = samplePage.items ?? [];

      const fields = discoverFields(catalogFields(fieldsByName));
      const foreignKeys: DiscoveredTable["foreignKeys"] = [];

      for (const field of fields) {
        for (const record of records) {
          if (field.samples.length >= SAMPLES_PER_FIELD) break;
          const value = toRow(record, [field.name], fieldsByName)[field.name];
          if (value !== null) field.samples.push(value);
        }
      }
      for (const field of fieldsByName.values()) {
        if (field.field_name === RECORD_ID) continue;
        const isLink = field.type === LARK_TYPE.singleLink || field.type === LARK_TYPE.duplexLink;
        const target = field.property?.table_id ? idToName.get(field.property.table_id) : undefined;
        if (isLink && target) {
          foreignKeys.push({ field: field.field_name, targetTable: target, targetField: RECORD_ID });
        }
      }

      answers.push({
        name: table.name,
        sourceDescription: "lark base table",
        ...(samplePage.total !== undefined ? { rowCount: samplePage.total } : {}),
        storesRows: true,
        primaryKey: [RECORD_ID],
        foreignKeys,
        fields,
      });
    }

    return { tables: answers, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  // #endregion
}
