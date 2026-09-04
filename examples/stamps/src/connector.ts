import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  ConnectorError,
  OPS,
  unknownEntity,
  unsupported,
  type AtlasJson,
  type CheckRequest,
  type CountRequest,
  type DiscoveredField,
  type DiscoveredTable,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type NativeQueryRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { z } from "zod";
import { StampsClient } from "./stamps-api";

const ATLAS_JSON: AtlasJson = {
  protocolVersion: 1,
  slug: "stamps",
  capabilities: {
    operators: [...OPS],
    dateBucket: false,
    sort: "none",
    offset: false,
    count: "scan",
    join: false,
    enforcesDeclaredKeys: false,
    probeConcurrency: 2,
    cheapProbes: false,
  },
  credentialSchema: [
    {
      key: "merchantToken",
      label: "Merchant token",
      type: "password",
      required: true,
      placeholder: "40-character merchant token",
      help: "Stamps CRM → **Settings → API Settings → Merchant → Token**. See the [Stamps API v4 documentation](https://staging-crm2.stamps.id/api/v4/docs).",
    },
    {
      key: "baseUrl",
      label: "API base URL",
      type: "text",
      required: false,
      placeholder: "https://staging-crm2.stamps.id",
      help: "Optional Stamps staging host. Leave blank for `https://staging-crm2.stamps.id`; the secondary `https://staging-crm.stamps.id` host is also accepted.",
    },
  ],
  endpoints: [],
};

const TableName = z.enum(["stores", "rewards"]);
type TableName = z.infer<typeof TableName>;

type FieldDefinition = Pick<
  DiscoveredField,
  "name" | "type" | "nullable" | "unique"
>;

function field(
  name: string,
  type: DiscoveredField["type"],
  nullable: boolean,
  unique = false,
): FieldDefinition {
  return { name, type, nullable, unique };
}

const TABLES: Record<TableName, { fields: FieldDefinition[] }> = {
  stores: {
    fields: [
      field("id", "number", false, true),
      field("name", "string", false),
      field("code", "string", true),
      field("area", "string", true),
      field("display_name", "string", true),
      field("address", "string", true),
      field("phone", "string", true),
      field("email", "string", true),
      field("slug", "string", true),
      field("latitude", "number", true),
      field("longitude", "number", true),
      field("timezone", "string", true),
      field("photo_url", "string", true),
      field("is_active", "boolean", false),
      field("description", "string", true),
      field("regency", "string", true),
      field("province", "string", true),
    ],
  },
  rewards: {
    fields: [
      field("id", "number", false, true),
      field("code", "string", true),
      field("name", "string", false),
      field("stamps_to_redeem", "number", false),
      field("user_redemption_limit", "number", true),
      field("picture_url", "string", false),
      field("landscape_url", "string", false),
      field("is_active", "boolean", false),
      field("start_date", "date", true),
      field("end_date", "date", true),
      field("type", "string", false),
      field("redeemable", "boolean", false),
      field("is_visible", "boolean", false),
      field("merchant_code", "string", false),
      field("description", "string", false),
      field("terms", "string", false),
    ],
  },
};

function tableOf(name: string): TableName {
  const table = TableName.safeParse(name);
  if (!table.success) throw unknownEntity(`unknown table "${name}"`);
  return table.data;
}

function project(row: SourceRow, fields: string[]): SourceRow {
  return Object.fromEntries(
    fields.map((name) => {
      const value = row[name];
      if (value === undefined) {
        throw new ConnectorError(500, `Stamps row is missing declared field "${name}"`);
      }
      return [name, value];
    }),
  );
}

export class StampsConnector extends AtlasConnector {
  readonly slug = ATLAS_JSON.slug;

  capability() {
    return ATLAS_JSON;
  }

  async check(req: CheckRequest): Promise<void> {
    await new StampsClient(req.credentials, req.timeoutMs).listStores();
  }

  private async *rows(
    table: TableName,
    client: StampsClient,
  ): AsyncIterable<SourceRow[]> {
    if (table === "stores") {
      yield await client.listStores();
      return;
    }
    yield* client.listRewards();
  }

  async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    const table = tableOf(req.table);
    const fields = TABLES[table].fields.map((definition) => definition.name);
    assertKnownFields(req, fields);
    const unknownProjection = req.fields.find((name) => !fields.includes(name));
    if (unknownProjection) {
      throw unsupported(`unknown projection field '${unknownProjection}'`);
    }
    if (req.sort.length > 0 || (req.offset ?? 0) > 0 || (req.joins?.length ?? 0) > 0) {
      throw unsupported("sorting, offsets, and joins are not supported");
    }
    const client = new StampsClient(req.credentials, req.timeoutMs);
    let remaining = req.limit ?? Number.POSITIVE_INFINITY;
    for await (const batch of this.rows(table, client)) {
      const filtered = applyFilters(batch, { and: req.and, or: req.or }, req.fieldTypes);
      const limited = filtered.length > remaining ? filtered.slice(0, remaining) : filtered;
      remaining -= limited.length;
      if (limited.length > 0) yield limited.map((row) => project(row, req.fields));
      if (remaining <= 0) return;
    }
  }

  async count(req: CountRequest): Promise<number> {
    const table = tableOf(req.table);
    const fields = TABLES[table].fields.map((definition) => definition.name);
    assertKnownFields(req, fields);
    const client = new StampsClient(req.credentials, req.timeoutMs);
    let count = 0;
    for await (const batch of this.rows(table, client)) {
      count += applyFilters(batch, { and: req.and, or: req.or }, req.fieldTypes).length;
    }
    return count;
  }

  async discover(_req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    const tables: DiscoveredTable[] = TableName.options.map((name) => ({
      name,
      sourceDescription: `Stamps API v4 ${name}`,
      storesRows: true,
      primaryKey: ["id"],
      foreignKeys: [],
      fields: TABLES[name].fields.map((definition) => ({
        ...definition,
        sourceColumn: definition.name,
        samples: [],
        sourceDescription: `Stamps API v4 ${name}.${definition.name}`,
      })),
    }));
    return { tables };
  }
}
