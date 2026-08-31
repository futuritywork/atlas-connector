// one connector = one lark base (app_token): bitable tables → atlas tables, fields → columns,
// records/search → rows. lark evaluates the pushable slice of a filter; applyFilters re-runs
// the full set locally so every advertised op is honored regardless of what pushed.

import {
  applyFilters,
  AtlasConnector,
  columnCountsFromValues,
  CONNECTOR_LIMITS,
  grainFromValues,
  linkFromValues,
  unknownEntity,
  unsupported,
  type AtlasType,
  type AtlasValue,
  type CountExactRequest,
  type CountRequest,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type DiscoveredField,
  type DiscoveredTable,
  type Filter,
  type GrainProbe,
  type LinkProbe,
  type NativeQueryRequest,
  type NativeQueryStreamRequest,
  type ProbeColumnsRequest,
  type ProbeGrainRequest,
  type ProbeLinkRequest,
  type SampleKeyValuesRequest,
  type SourceRow,
  type TableColumnsProbe,
  type UserSort,
} from "@futurity/atlas-connector";
import { byteOrderCompare } from "./byte-order";
import { ATLAS_JSON } from "./capability";
import { atlasTypeOf, flattenValue, LARK_TYPE } from "./field-map";
import { LarkClient, makeDeadline, type Deadline, type LarkField, type LarkTable } from "./lark-api";
import { pushdownConditions } from "./pushdown";

const RECORD_ID = "record_id";
const META_CACHE_MS = 60_000;
const SAMPLE_PAGE_SIZE = 20;
const SAMPLES_PER_FIELD = 5;

// the slice of a wire request that scan/scanFiltered read; every ten-method request satisfies it
type QueryShape = {
  table: string;
  and: Filter[];
  or?: Filter[][];
  fields: string[];
  sort?: UserSort[];
  joins?: unknown[];
  fieldTypes?: Record<string, AtlasType>;
};

export class LarkConnector extends AtlasConnector {
  readonly slug = "lark-base";

  private tableCache: { at: number; byName: Map<string, LarkTable> } | null = null;
  private fieldCache = new Map<string, { at: number; byName: Map<string, LarkField> }>();

  constructor(private readonly client: LarkClient) {
    super();
  }

  capability() {
    return ATLAS_JSON;
  }

  private async tables(deadline: Deadline): Promise<Map<string, LarkTable>> {
    if (this.tableCache && Date.now() - this.tableCache.at < META_CACHE_MS) return this.tableCache.byName;
    const byName = new Map((await this.client.listTables(deadline)).map((table) => [table.name, table]));
    this.tableCache = { at: Date.now(), byName };
    return byName;
  }

  private async resolveTable(name: string, deadline: Deadline): Promise<LarkTable> {
    const table = (await this.tables(deadline)).get(name);
    if (!table) throw unknownEntity(`unknown table "${name}"`);
    return table;
  }

  private async fields(tableId: string, deadline: Deadline): Promise<Map<string, LarkField>> {
    const cached = this.fieldCache.get(tableId);
    if (cached && Date.now() - cached.at < META_CACHE_MS) return cached.byName;
    const byName = new Map((await this.client.listFields(tableId, deadline)).map((field) => [field.field_name, field]));
    this.fieldCache.set(tableId, { at: Date.now(), byName });
    return byName;
  }

  // ---- row production ----------------------------------------------------

  // the columns a fetch must carry: projection + every filter and sort operand
  private static neededColumns(req: QueryShape): Set<string> {
    const needed = new Set(req.fields);
    for (const filter of req.and) needed.add(filter.field);
    for (const group of req.or ?? []) for (const filter of group) needed.add(filter.field);
    for (const sort of req.sort ?? []) needed.add(sort.field);
    return needed;
  }

  private static toRow(
    record: { record_id: string; fields: Record<string, unknown> },
    columns: Iterable<string>,
    fieldsByName: Map<string, LarkField>,
  ): SourceRow {
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

  // scan the table under the pushable slice of and[]; rows carry exactly `columns`
  private async *scan(req: QueryShape, deadline: Deadline): AsyncIterable<SourceRow[]> {
    if (req.joins && req.joins.length > 0) throw unsupported("joins are not supported; atlas joins locally");
    const table = await this.resolveTable(req.table, deadline);
    const fieldsByName = await this.fields(table.table_id, deadline);
    const columns = LarkConnector.neededColumns(req);
    const realFields = [...columns].filter((column) => fieldsByName.has(column));
    const conditions = pushdownConditions(req.and, fieldsByName);
    const batches = this.client.searchAll(table.table_id, deadline, {
      // field_names must name real fields; record_id rides along on every record anyway
      fieldNames: realFields.length > 0 ? realFields : undefined,
      conditions,
    });
    for await (const records of batches) {
      yield records.map((record) => LarkConnector.toRow(record, columns, fieldsByName));
    }
  }

  // scan batches with the FULL filter set re-applied locally; batches may come out empty
  private async *scanFiltered(req: QueryShape, deadline: Deadline): AsyncIterable<SourceRow[]> {
    for await (const batch of this.scan(req, deadline)) {
      yield applyFilters(batch, { and: req.and, or: req.or }, req.fieldTypes);
    }
  }

  // one column's values across the whole table, nulls included — probe and sample feedstock
  private async columnValues(tableName: string, column: string, deadline: Deadline): Promise<AtlasValue[]> {
    const shape: QueryShape = { table: tableName, and: [], fields: [column] };
    const values: AtlasValue[] = [];
    for await (const batch of this.scan(shape, deadline)) {
      for (const row of batch) values.push(row[column]);
    }
    return values;
  }

  // ---- sort / paging / projection ----------------------------------------

  private static compareCell(a: AtlasValue, b: AtlasValue, type: AtlasType | undefined): number {
    if (a === null || b === null) return a === null && b === null ? 0 : a === null ? 1 : -1; // nulls last (asc)
    if (type === "number" || type === "decimal") {
      const left = Number(a);
      const right = Number(b);
      if (Number.isFinite(left) && Number.isFinite(right)) return left < right ? -1 : left > right ? 1 : 0;
    }
    return byteOrderCompare(String(a), String(b));
  }

  private static sortRows(rows: SourceRow[], sort: UserSort[], fieldTypes?: Record<string, AtlasType>): void {
    if (sort.length === 0) return;
    rows.sort((a, b) => {
      for (const key of sort) {
        const order = LarkConnector.compareCell(a[key.field], b[key.field], fieldTypes?.[key.field]);
        if (order !== 0) return key.dir === "desc" ? -order : order;
      }
      return 0;
    });
  }

  private static project(rows: SourceRow[], fields: string[]): SourceRow[] {
    return rows.map((row) => {
      const out: SourceRow = {};
      for (const field of fields) out[field] = row[field];
      return out;
    });
  }

  // ---- the ten methods ----------------------------------------------------

  async query(req: NativeQueryRequest): Promise<SourceRow[]> {
    const deadline = makeDeadline(req.timeoutMs);
    const rows: SourceRow[] = [];
    for await (const batch of this.scanFiltered(req, deadline)) rows.push(...batch);
    LarkConnector.sortRows(rows, req.sort, req.fieldTypes);
    const offset = req.offset ?? 0;
    const sliced = rows.slice(offset, req.limit !== undefined ? offset + req.limit : undefined);
    return LarkConnector.project(sliced, req.fields);
  }

  async *queryStream(req: NativeQueryStreamRequest): AsyncIterable<SourceRow[]> {
    // sort or offset needs the whole result before the first row can leave
    if (req.sort.length > 0 || (req.offset ?? 0) > 0) {
      const rows = await this.query(req);
      for (let i = 0; i < rows.length; i += CONNECTOR_LIMITS.rowsPerBatch) {
        yield rows.slice(i, i + CONNECTOR_LIMITS.rowsPerBatch);
      }
      return;
    }
    const deadline = makeDeadline(req.maxTimeoutMs);
    let remaining = req.limit ?? Infinity;
    for await (const kept of this.scanFiltered(req, deadline)) {
      const capped = kept.length > remaining ? kept.slice(0, remaining) : kept;
      remaining -= capped.length;
      if (capped.length > 0) yield LarkConnector.project(capped, req.fields);
      if (remaining <= 0) return;
    }
  }

  async count(req: CountRequest): Promise<number> {
    const deadline = makeDeadline(req.timeoutMs);
    // scan-and-tally: lark's filtered `total` is untested against residual semantics
    const shape: QueryShape = { table: req.table, and: req.and, or: req.or, fields: [], fieldTypes: req.fieldTypes };
    let count = 0;
    for await (const batch of this.scanFiltered(shape, deadline)) count += batch.length;
    return count;
  }

  async sampleKeyValues(req: SampleKeyValuesRequest): Promise<string[]> {
    const deadline = makeDeadline(req.timeoutMs);
    const values = await this.columnValues(req.table, req.column, deadline);
    const distinct = new Set<string>();
    for (const value of values) {
      if (value !== null) distinct.add(String(value));
    }
    const numeric = req.type === "number" || req.type === "decimal";
    const sorted = [...distinct].sort((a, b) =>
      numeric ? (Number(a) || 0) - (Number(b) || 0) : byteOrderCompare(a, b),
    );
    return sorted.slice(0, req.limit);
  }

  override async countExact(req: CountExactRequest): Promise<number | null> {
    const deadline = makeDeadline(req.timeoutMs);
    const table = await this.resolveTable(req.table, deadline);
    return await this.client.recordTotal(table.table_id, deadline);
  }

  override async probeColumns(req: ProbeColumnsRequest): Promise<TableColumnsProbe | null> {
    const deadline = makeDeadline(req.timeoutMs);
    const shape: QueryShape = { table: req.table, and: [], fields: req.columns };
    const perColumn: Record<string, AtlasValue[]> = Object.fromEntries(req.columns.map((column) => [column, []]));
    for await (const batch of this.scan(shape, deadline)) {
      for (const row of batch) {
        for (const column of req.columns) perColumn[column].push(row[column]);
      }
    }
    return columnCountsFromValues(perColumn);
  }

  override async probeLink(req: ProbeLinkRequest): Promise<LinkProbe | null> {
    const deadline = makeDeadline(req.timeoutMs);
    const fromValues = await this.columnValues(req.fromTable, req.fromColumn, deadline);
    const toValues = await this.columnValues(req.toTable, req.toColumn, deadline);
    return linkFromValues(fromValues, toValues);
  }

  override async probeGrain(req: ProbeGrainRequest): Promise<GrainProbe | null> {
    const deadline = makeDeadline(req.timeoutMs);
    return grainFromValues(await this.columnValues(req.table, req.column, deadline));
  }

  // ---- discovery -----------------------------------------------------------

  async discovery(req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    const deadline = makeDeadline(req.timeoutMs);
    const tables = await this.tables(deadline);
    const idToName = new Map([...tables.values()].map((table) => [table.table_id, table.name]));
    const answers: DiscoveredTable[] = [];
    const warnings: string[] = [];

    for (const table of tables.values()) {
      const fieldsByName = await this.fields(table.table_id, deadline);
      if (fieldsByName.has(RECORD_ID)) {
        warnings.push(`table "${table.name}" has a field literally named record_id; the lark record id shadows it`);
      }
      const samplePage = await this.client.searchPage(table.table_id, deadline, { pageSize: SAMPLE_PAGE_SIZE });
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
}
