import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  unknownEntity,
  unsupported,
  type CheckRequest,
  type CountRequest,
  type DiscoveredField,
  type DiscoveredTable,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type NativeQueryRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { ATLAS_JSON } from "./capability";
import {
  StampsClient,
  type StampsFetch,
  type StampsReward,
  type StampsStore,
} from "./stamps-api";

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

const TABLES: { name: string; fields: FieldDefinition[] }[] = [
  {
    name: "stores",
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
  {
    name: "rewards",
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
];

const FIELDS = new Map(TABLES.map((table) => [table.name, table.fields]));

function fieldsOf(table: string): string[] {
  const fields = FIELDS.get(table);
  if (!fields) throw unknownEntity(`unknown table "${table}"`);
  return fields.map((definition) => definition.name);
}

function storeRow(store: StampsStore): SourceRow {
  return {
    id: store.id,
    name: store.name,
    code: store.code,
    area: store.area,
    display_name: store.display_name,
    address: store.address,
    phone: store.phone,
    email: store.email,
    slug: store.slug,
    latitude: store.latitude,
    longitude: store.longitude,
    timezone: store.timezone,
    photo_url: store.photo_url,
    is_active: store.is_active,
    description: store.description,
    regency: store.regency,
    province: store.province,
  };
}

function rewardRow(reward: StampsReward): SourceRow {
  return {
    id: reward.id,
    code: reward.code,
    name: reward.name,
    stamps_to_redeem: reward.stamps_to_redeem,
    user_redemption_limit: reward.user_redemption_limit,
    picture_url: reward.picture_url,
    landscape_url: reward.landscape_url,
    is_active: reward.is_active,
    start_date: reward.start_date,
    end_date: reward.end_date,
    type: String(reward.type),
    redeemable: reward.redeemable,
    is_visible: reward.is_visible,
    merchant_code: reward.merchant_code,
    description: reward.description,
    terms: reward.terms,
  };
}

function project(row: SourceRow, fields: string[]): SourceRow {
  return Object.fromEntries(fields.map((name) => [name, row[name] ?? null]));
}

export class StampsConnector extends AtlasConnector {
  readonly slug = "stamps";

  constructor(private readonly fetcher: StampsFetch = fetch) {
    super();
  }

  capability() {
    return ATLAS_JSON;
  }

  async check(req: CheckRequest): Promise<void> {
    await new StampsClient(req.credentials, this.fetcher).listStores(req.timeoutMs);
  }

  private async *rows(
    table: string,
    client: StampsClient,
    timeoutMs: number,
  ): AsyncIterable<SourceRow[]> {
    if (table === "stores") {
      yield (await client.listStores(timeoutMs)).map(storeRow);
      return;
    }
    if (table === "rewards") {
      for await (const rewards of client.listRewards(timeoutMs)) {
        yield rewards.map(rewardRow);
      }
      return;
    }
    throw unknownEntity(`unknown table "${table}"`);
  }

  async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    const fields = fieldsOf(req.table);
    assertKnownFields(req, fields);
    const unknownProjection = req.fields.find((name) => !fields.includes(name));
    if (unknownProjection) {
      throw unsupported(`unknown projection field '${unknownProjection}'`);
    }
    if (req.sort.length > 0 || (req.offset ?? 0) > 0 || (req.joins?.length ?? 0) > 0) {
      throw unsupported("sorting, offsets, and joins are not supported");
    }
    const client = new StampsClient(req.credentials, this.fetcher);
    let remaining = req.limit ?? Number.POSITIVE_INFINITY;
    for await (const batch of this.rows(req.table, client, req.timeoutMs)) {
      const filtered = applyFilters(batch, { and: req.and, or: req.or }, req.fieldTypes);
      const limited = filtered.length > remaining ? filtered.slice(0, remaining) : filtered;
      remaining -= limited.length;
      if (limited.length > 0) yield limited.map((row) => project(row, req.fields));
      if (remaining <= 0) return;
    }
  }

  async count(req: CountRequest): Promise<number> {
    const fields = fieldsOf(req.table);
    assertKnownFields(req, fields);
    const client = new StampsClient(req.credentials, this.fetcher);
    let count = 0;
    for await (const batch of this.rows(req.table, client, req.timeoutMs)) {
      count += applyFilters(batch, { and: req.and, or: req.or }, req.fieldTypes).length;
    }
    return count;
  }

  async discover(_req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    const tables: DiscoveredTable[] = TABLES.map((table) => ({
      name: table.name,
      sourceDescription: `Stamps API v4 ${table.name}`,
      storesRows: true,
      primaryKey: ["id"],
      foreignKeys: [],
      fields: table.fields.map((definition) => ({
        ...definition,
        sourceColumn: definition.name,
        samples: [],
        sourceDescription: `Stamps API v4 ${table.name}.${definition.name}`,
      })),
    }));
    return { tables };
  }

  // profileColumns, profileLink, profileGrain, exactCount, and sampleColumnValues already answer
  // by scanning through query(); override one only where your api can do that math cheaper.
}
