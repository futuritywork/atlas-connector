import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  defineCapability,
  defineCatalog,
  discoverFields,
  field,
  fieldTypes,
  unknownEntity,
  unsupported,
  windowRows,
  type CapabilityDoc,
  type CheckRequest,
  type DiscoveredTable,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type EntitySize,
  type Field,
  type NativeQueryRequest,
  type QueryChunk,
  type SizeRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { StampsClient, type Store, type Reward } from "./stamps-api";

// the v4 api filters and sorts nothing, so the pushdown map is empty and Atlas narrows these tables
const ATLAS_JSON: CapabilityDoc = defineCapability({
  slug: "stamps",
  pushdown: {},
  limits: { pageSizeMax: 100, concurrency: 1 },
  keysEnforced: false,
  dateBucket: false,
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
});

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
  return Object.fromEntries(fields.map((name) => [name, row[name]]));
}

export class StampsConnector extends AtlasConnector {
  readonly slug = ATLAS_JSON.slug;

  capabilities() {
    return ATLAS_JSON;
  }

  async check(req: CheckRequest): Promise<void> {
    await new StampsClient(req.credentials, req.timeoutMs).listStores();
  }

  private async *scan(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    const table = tableOf(req.table);
    const types = fieldTypes(table.columns);
    assertKnownFields(req, Object.keys(types));
    if (req.joins?.length) throw unsupported("joins are not supported; Atlas joins locally");
    const client = new StampsClient(req.credentials, req.timeoutMs);
    const pages = table.name === "stores" ? [await client.listStores()] : client.listRewards();
    for await (const page of pages) {
      yield applyFilters(page, req, types);
    }
  }

  // the api narrows nothing and has no order to ask for, so every predicate runs here
  async *query(req: NativeQueryRequest): AsyncIterable<QueryChunk> {
    const sortRequested = req.sort.length > 0;
    yield { served: { filters: true, sort: false, window: !sortRequested } };
    const filtered = this.scan(req);
    const rows = sortRequested ? filtered : windowRows(filtered, req);
    for await (const batch of rows) {
      yield batch.map((row) => project(row, req.fields));
    }
  }

  // /stores/ answers its whole index in one request; rewards only pages, so Atlas owns that walk
  override async size(req: SizeRequest): Promise<EntitySize | null> {
    if (tableOf(req.table).name !== "stores") return null;
    const stores = await new StampsClient(req.credentials, req.timeoutMs).listStores();
    return { rows: stores.length, exact: true };
  }

  async discovery(_req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    const tables: DiscoveredTable[] = catalog.tables.map(({ name, columns }) => ({
      name,
      sourceDescription: `Stamps API v4 ${name}`,
      storesRows: true,
      primaryKey: ["id"],
      foreignKeys: [],
      fields: discoverFields(columns).map((column) => ({
        ...column,
        sourceDescription: `Stamps API v4 ${name}.${column.name}`,
      })),
    }));
    return { tables };
  }
}
