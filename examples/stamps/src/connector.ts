import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  ConnectorError,
  defineCatalog,
  discoverFields,
  field,
  fieldTypes,
  OPS,
  unknownEntity,
  unsupported,
  windowRows,
  type AtlasJson,
  type CheckRequest,
  type Field,
  type DiscoveredTable,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type NativeQueryRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { StampsClient, type Store, type Reward } from "./stamps-api";

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

const catalog = defineCatalog([
  {
    name: "stores" as const,
    columns: [
      field("id", "number", { nullable: false, unique: true }),
      field("name", "string", { nullable: false }),
      field("code", "string", { nullable: true }),
      field("area", "string", { nullable: true }),
      field("display_name", "string", { nullable: true }),
      field("address", "string", { nullable: true }),
      field("phone", "string", { nullable: true }),
      field("email", "string", { nullable: true }),
      field("slug", "string", { nullable: true }),
      field("latitude", "number", { nullable: true }),
      field("longitude", "number", { nullable: true }),
      field("timezone", "string", { nullable: true }),
      field("photo_url", "string", { nullable: true }),
      field("is_active", "boolean", { nullable: false }),
      field("description", "string", { nullable: true }),
      field("regency", "string", { nullable: true }),
      field("province", "string", { nullable: true }),
    ] satisfies (Field & { name: keyof Store })[],
  },
  {
    name: "rewards" as const,
    columns: [
      field("id", "number", { nullable: false, unique: true }),
      field("code", "string", { nullable: true }),
      field("name", "string", { nullable: false }),
      field("stamps_to_redeem", "number", { nullable: false }),
      field("user_redemption_limit", "number", { nullable: true }),
      field("picture_url", "string", { nullable: false }),
      field("landscape_url", "string", { nullable: false }),
      field("is_active", "boolean", { nullable: false }),
      field("start_date", "date", { nullable: true }),
      field("end_date", "date", { nullable: true }),
      field("type", "string", { nullable: false }),
      field("redeemable", "boolean", { nullable: false }),
      field("is_visible", "boolean", { nullable: false }),
      field("merchant_code", "string", { nullable: false }),
      field("description", "string", { nullable: false }),
      field("terms", "string", { nullable: false }),
    ] satisfies (Field & { name: keyof Reward })[],
  },
]);

function tableOf(name: string) {
  const table = catalog.getTable(name);
  if (!table) throw unknownEntity(`unknown table "${name}"`);
  return table;
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

  private async *scan(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    const table = tableOf(req.table);
    const types = fieldTypes(table.columns);
    assertKnownFields(req, Object.keys(types));
    if (req.sort.length > 0 || (req.offset ?? 0) > 0 || (req.joins?.length ?? 0) > 0) {
      throw unsupported("sorting, offsets, and joins are not supported");
    }
    const client = new StampsClient(req.credentials, req.timeoutMs);
    const batches = table.name === "stores" ? [await client.listStores()] : client.listRewards();
    for await (const batch of batches) {
      yield applyFilters(batch, req, types);
    }
  }

  async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    for await (const batch of windowRows(this.scan(req), req)) {
      yield batch.map((row) => project(row, req.fields));
    }
  }

  async discover(_req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    const tables: DiscoveredTable[] = catalog.tables.map(({ name, columns }) => ({
      name,
      sourceDescription: `Stamps API v4 ${name}`,
      storesRows: true,
      primaryKey: ["id"],
      foreignKeys: [],
      fields: discoverFields(columns).map((field) => ({
        ...field,
        sourceDescription: `Stamps API v4 ${name}.${field.name}`,
      })),
    }));
    return { tables };
  }
}
