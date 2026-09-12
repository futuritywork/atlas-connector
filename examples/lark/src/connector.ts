// credentials and app_token arrive on every request, so one process serves any base and keeps none

import {
  assertKnownFields,
  AtlasConnector,
  discoverFields,
  field,
  unknownEntity,
  unsupported,
  windowRows,
  type CheckRequest,
  type CountRequest,
  type Credentials,
  type DiscoveredTable,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type EntitySize,
  type NativeQueryRequest,
  type QueryChunk,
  type SizeRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { CAPABILITY } from "./capability";
import { atlasTypeOf, flattenValue, LARK_TYPE, RECORD_ID } from "./field-map";
import {
  LarkClient,
  larkCredentials,
  makeDeadline,
  MAX_PAGE_SIZE,
  type Deadline,
  type LarkField,
  type LarkRecord,
  type LarkTable,
} from "./lark-api";
import { planFilter, planSort, recordIdLookup, servedBy } from "./pushdown";

const META_CACHE_MS = 60_000;
const SAMPLE_PAGE_SIZE = 20;
const SAMPLES_PER_FIELD = 5;

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
  const recordId = field(RECORD_ID, "string", { unique: true, description: "lark record id (system primary key)" });
  const columns = [...fieldsByName.values()]
    .filter((source) => source.field_name !== RECORD_ID)
    .map((source) =>
      field(source.field_name, atlasTypeOf(source), {
        nullable: true,
        description: `lark ${source.ui_type ?? `type ${source.type}`}`,
      }),
    );
  return [recordId, ...columns];
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

async function* toRows(
  batches: AsyncIterable<LarkRecord[]>,
  columns: Iterable<string>,
  fieldsByName: Map<string, LarkField>,
): AsyncIterable<SourceRow[]> {
  for await (const records of batches) {
    yield records.map((record) => toRow(record, columns, fieldsByName));
  }
}

function project(rows: SourceRow[], fields: string[]): SourceRow[] {
  return rows.map((row) => {
    const out: SourceRow = {};
    for (const name of fields) out[name] = row[name];
    return out;
  });
}

// offset+limit rows and no more, so one page can be the whole answer
function pageSizeFor(req: NativeQueryRequest): number | undefined {
  if (req.limit === undefined) return undefined;
  return Math.min(MAX_PAGE_SIZE, (req.offset ?? 0) + req.limit);
}

export class LarkConnector extends AtlasConnector {
  readonly slug = "lark-base";

  // keyed by credential set: one tenant must never read another's tables
  private readonly metaByCredential = new Map<string, BaseMeta>();

  capabilities() {
    return CAPABILITY;
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

  // without the record id, which shadows a field spelled the same way
  private async filterableFields(
    client: LarkClient,
    table: LarkTable,
    meta: BaseMeta,
    deadline: Deadline,
  ): Promise<Map<string, LarkField>> {
    const byName = new Map(await this.fields(client, meta, table.table_id, deadline));
    byName.delete(RECORD_ID);
    return byName;
  }

  // #endregion

  // #region protocol

  async *query(req: NativeQueryRequest): AsyncIterable<QueryChunk> {
    if (req.joins && req.joins.length > 0) throw unsupported("joins are not supported; atlas joins locally");
    const client = clientFor(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const { meta, table } = await this.resolveTable(client, req.table, deadline);
    const fieldsByName = await this.filterableFields(client, table, meta, deadline);
    const columns = assertKnownFields(req, [RECORD_ID, ...fieldsByName.keys()]);

    const recordId = recordIdLookup(req.and);
    if (recordId !== null) {
      // the get evaluates that one eq only; a second predicate stays the host's
      const soleFilter = req.and.length === 1 && (req.or?.length ?? 0) === 0;
      yield { served: { filters: soleFilter, sort: true, window: soleFilter && (req.offset ?? 0) === 0 } };
      const record = await client.getRecord(table.table_id, recordId, deadline);
      if (record) yield project([toRow(record, columns, fieldsByName)], req.fields);
      return;
    }

    const filter = planFilter(req.and, req.or, fieldsByName);
    const sort = planSort(req.sort, fieldsByName);
    const served = servedBy(filter, sort);
    yield { served };

    // field_names must name real fields; record_id rides on every record anyway
    const realFields = [...columns].filter((column) => fieldsByName.has(column));
    const pages = client.searchAll(table.table_id, deadline, {
      ...(realFields.length > 0 ? { fieldNames: realFields } : {}),
      ...(filter.filter ? { filter: filter.filter } : {}),
      ...(sort && sort.length > 0 ? { sort } : {}),
      ...(served.window ? { pageSize: pageSizeFor(req) } : {}),
    });

    const rows = toRows(pages, columns, fieldsByName);
    for await (const batch of served.window ? windowRows(rows, req) : rows) {
      deadline.check();
      yield project(batch, req.fields);
    }
  }

  // total counts the pushed-filter matches uncapped, so an exact filter set is one request
  async count(req: CountRequest): Promise<number> {
    const client = clientFor(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const { meta, table } = await this.resolveTable(client, req.table, deadline);
    const fieldsByName = await this.filterableFields(client, table, meta, deadline);
    assertKnownFields(req, [RECORD_ID, ...fieldsByName.keys()]);

    const filter = planFilter(req.and, req.or, fieldsByName);
    if (!filter.exact) {
      throw unsupported("lark counts only filters it evaluates as atlas does; tally /query for this one");
    }
    const total = await client.recordTotal(table.table_id, deadline, filter.filter);
    if (total === null) throw unsupported("lark answered this search without a total");
    return total;
  }

  async size(req: SizeRequest): Promise<EntitySize | null> {
    const client = clientFor(req.credentials);
    const deadline = makeDeadline(req.timeoutMs);
    const { table } = await this.resolveTable(client, req.table, deadline);
    const total = await client.recordTotal(table.table_id, deadline);
    return total === null ? null : { rows: total, exact: true };
  }

  async discovery(req: DiscoveryRequest): Promise<DiscoveryAnswer> {
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

      for (const discovered of fields) {
        for (const record of records) {
          if (discovered.samples.length >= SAMPLES_PER_FIELD) break;
          const value = toRow(record, [discovered.name], fieldsByName)[discovered.name];
          if (value !== null) discovered.samples.push(value);
        }
      }
      for (const source of fieldsByName.values()) {
        if (source.field_name === RECORD_ID) continue;
        const isLink = source.type === LARK_TYPE.singleLink || source.type === LARK_TYPE.duplexLink;
        const target = source.property?.table_id ? idToName.get(source.property.table_id) : undefined;
        if (isLink && target) {
          foreignKeys.push({ field: source.field_name, targetTable: target, targetField: RECORD_ID });
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
