// lark base (bitable) → atlas: tables → atlas tables, fields → columns, records/search → rows.
// the tenant's app credentials and app_token arrive on every request, so one process serves any number of bases and keeps none of them.
// lark evaluates the pushable slice of a filter; applyFilters re-runs the full set, so every advertised op holds.

import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  CONNECTOR_LIMITS,
  unknownEntity,
  unsupported,
  type AtlasType,
  type AtlasValue,
  type CheckRequest,
  type CountExactRequest,
  type CountRequest,
  type Credentials,
  type DiscoveredField,
  type DiscoveredTable,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type Filter,
  type NativeQueryRequest,
  type SourceRow,
  type UserSort,
} from "@futurity/atlas-connector";
import { byteOrderCompare } from "./byte-order";
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
type QueryShape = {
  table: string;
  and: Filter[];
  or?: Filter[][];
  fields: string[];
  sort?: UserSort[];
  joins?: unknown[];
  fieldTypes?: Record<string, AtlasType>;
};

// one base's metadata, expiring as a unit
type BaseMeta = {
  at: number;
  tables: Map<string, LarkTable>;
  fields: Map<string, Map<string, LarkField>>;
};

function clientFor(credentials: Credentials): LarkClient {
  return new LarkClient(larkCredentials(credentials));
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

function compareCell(a: AtlasValue, b: AtlasValue, type: AtlasType | undefined): number {
  // nulls last (asc)
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

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

function sortRows(rows: SourceRow[], sort: UserSort[], fieldTypes?: Record<string, AtlasType>): void {
  if (sort.length === 0) return;
  rows.sort((a, b) => {
    for (const key of sort) {
      const order = compareCell(a[key.field], b[key.field], fieldTypes?.[key.field]);
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
  private async *scan(client: LarkClient, req: QueryShape, deadline: Deadline): AsyncIterable<SourceRow[]> {
    if (req.joins && req.joins.length > 0) throw unsupported("joins are not supported; atlas joins locally");
    const { meta, table } = await this.resolveTable(client, req.table, deadline);
    const fieldsByName = await this.fields(client, meta, table.table_id, deadline);
    assertKnownFields(req, [RECORD_ID, ...fieldsByName.keys()]);
    const columns = neededColumns(req);
    const realFields = [...columns].filter((column) => fieldsByName.has(column));
    const batches = client.searchAll(table.table_id, deadline, {
      // field_names must name real fields; record_id rides along on every record anyway
      fieldNames: realFields.length > 0 ? realFields : undefined,
      conditions: pushdownConditions(req.and, fieldsByName),
    });
    for await (const records of batches) {
      yield records.map((record) => toRow(record, columns, fieldsByName));
    }
  }

  // scan batches with the FULL filter set re-applied locally; batches may come out empty
  private async *scanFiltered(client: LarkClient, req: QueryShape, deadline: Deadline): AsyncIterable<SourceRow[]> {
    for await (const batch of this.scan(client, req, deadline)) {
      yield applyFilters(batch, { and: req.and, or: req.or }, req.fieldTypes);
    }
  }

  // #endregion

  // #region protocol

  async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    const client = clientFor(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const offset = req.offset ?? 0;
    // sort and offset need the whole result before the first row can leave
    if (req.sort.length > 0 || offset > 0) {
      const rows: SourceRow[] = [];
      for await (const batch of this.scanFiltered(client, req, deadline)) rows.push(...batch);
      sortRows(rows, req.sort, req.fieldTypes);
      const end = req.limit !== undefined ? offset + req.limit : undefined;
      const window = rows.slice(offset, end);
      for (let i = 0; i < window.length; i += CONNECTOR_LIMITS.rowsPerBatch) {
        yield project(window.slice(i, i + CONNECTOR_LIMITS.rowsPerBatch), req.fields);
      }
      return;
    }
    let remaining = req.limit ?? Number.POSITIVE_INFINITY;
    for await (const kept of this.scanFiltered(client, req, deadline)) {
      const capped = kept.length > remaining ? kept.slice(0, remaining) : kept;
      remaining -= capped.length;
      if (capped.length > 0) yield project(capped, req.fields);
      if (remaining <= 0) return;
    }
  }

  async count(req: CountRequest): Promise<number> {
    const client = clientFor(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    // scan-and-tally: lark's filtered total is untested against the residual filters
    const shape: QueryShape = {
      table: req.table,
      and: req.and,
      or: req.or,
      fields: [],
      fieldTypes: req.fieldTypes,
    };
    let count = 0;
    for await (const batch of this.scanFiltered(client, shape, deadline)) count += batch.length;
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

      const fields: DiscoveredField[] = [
        {
          name: RECORD_ID,
          sourceColumn: RECORD_ID,
          type: "string",
          nullable: false,
          unique: true,
          samples: records.slice(0, SAMPLES_PER_FIELD).map((record) => record.record_id),
          sourceDescription: "lark record id (system primary key)",
        },
      ];
      const foreignKeys: { field: string; targetTable: string; targetField: string }[] = [];

      for (const field of fieldsByName.values()) {
        if (field.field_name === RECORD_ID) continue;
        const samples: AtlasValue[] = [];
        for (const record of records) {
          if (samples.length >= SAMPLES_PER_FIELD) break;
          const value = flattenValue(record.fields[field.field_name], field.type);
          if (value !== null) samples.push(value);
        }
        fields.push({
          name: field.field_name,
          sourceColumn: field.field_name,
          type: atlasTypeOf(field),
          nullable: true,
          unique: false,
          samples,
          sourceDescription: `lark ${field.ui_type ?? `type ${field.type}`}`,
        });
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
