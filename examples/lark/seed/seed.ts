// seeds one lark base (bitable) with a demo dataset for the atlas connector.
// wipes every table first, so reruns land the same rows.

// #region env + args

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

const DOMAIN = process.env.LARK_DOMAIN ?? "https://open.larksuite.com";
const APP_ID = required("LARK_APP_ID");
const APP_SECRET = required("LARK_APP_SECRET");
const APP_TOKEN = required("LARK_APP_TOKEN");

type DatasetName = "northwind" | "harbor";

function parseDataset(): DatasetName {
  const args = process.argv.slice(2);
  const inline = args.find((arg) => arg.startsWith("--dataset="));
  const flagAt = args.indexOf("--dataset");
  let value = flagAt >= 0 ? args[flagAt + 1] : undefined;
  if (inline) value = inline.slice("--dataset=".length);
  if (value !== "northwind" && value !== "harbor") {
    throw new Error("usage: bun run seed/seed.ts --dataset northwind|harbor");
  }
  return value;
}

// #endregion

// #region deterministic prng

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  between(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

// #endregion

// #region lark client

// bitable field type codes
const TEXT = 1;
const NUMBER = 2;
const SELECT = 3;
const DATE = 5;
const CHECKBOX = 7;
const PHONE = 13;
const URL = 15;
const LINK = 18;

const RATE_LIMITED = 99991400;
const BATCH_SIZE = 500;
const TOKEN_SLACK_MS = 5 * 60 * 1000;

type FieldSpec =
  | { name: string; type: typeof TEXT | typeof CHECKBOX | typeof PHONE | typeof URL }
  | { name: string; type: typeof NUMBER; formatter?: string }
  | { name: string; type: typeof SELECT; options: readonly string[] }
  | { name: string; type: typeof DATE }
  | { name: string; type: typeof LINK; target: string };

type Row = Record<string, unknown>;

type LarkTable = { table_id: string; name: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fieldPayload(field: FieldSpec, tableIds: Record<string, string>): Record<string, unknown> {
  switch (field.type) {
    case SELECT:
      return {
        field_name: field.name,
        type: SELECT,
        property: { options: field.options.map((name) => ({ name })) },
      };
    case DATE:
      return {
        field_name: field.name,
        type: DATE,
        property: { date_formatter: "yyyy/MM/dd", auto_fill: false },
      };
    case NUMBER:
      return { field_name: field.name, type: NUMBER, property: { formatter: field.formatter ?? "0" } };
    case LINK:
      return { field_name: field.name, type: LINK, property: { table_id: tableIds[field.target] } };
    default:
      return { field_name: field.name, type: field.type };
  }
}

class LarkBase {
  private token = "";
  private tokenExpiresAt = 0;

  private async tenantToken(): Promise<string> {
    if (Date.now() < this.tokenExpiresAt) return this.token;
    const res = await fetch(`${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const body = (await res.json()) as { code: number; msg: string; tenant_access_token?: string; expire?: number };
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`lark tenant_access_token: code=${body.code} ${body.msg}`);
    }
    this.token = body.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (body.expire ?? 7200) * 1000 - TOKEN_SLACK_MS;
    return this.token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tenantToken();
      const res = await fetch(`${DOMAIN}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const envelope = (await res.json()) as { code: number; msg: string; data?: T };
      if (envelope.code === 0) return envelope.data as T;
      // bitable write quotas are per-second, so a short backoff clears normal bursts
      if ((envelope.code === RATE_LIMITED || res.status === 429) && attempt < 5) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(`lark ${method} ${path}: code=${envelope.code} ${envelope.msg}`);
    }
  }

  async listTables(): Promise<LarkTable[]> {
    const tables: LarkTable[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: "100", ...(pageToken ? { page_token: pageToken } : {}) });
      const page = await this.call<{ items?: LarkTable[]; has_more: boolean; page_token?: string }>(
        "GET",
        `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables?${query}`,
      );
      tables.push(...(page.items ?? []));
      pageToken = page.has_more ? page.page_token : undefined;
    } while (pageToken);
    return tables;
  }

  async createTable(name: string, fields: readonly FieldSpec[], tableIds: Record<string, string>): Promise<string> {
    const created = await this.call<{ table_id: string }>("POST", `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables`, {
      table: { name, fields: fields.map((field) => fieldPayload(field, tableIds)) },
    });
    return created.table_id;
  }

  async deleteTable(tableId: string): Promise<void> {
    await this.call("DELETE", `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}`);
  }

  // returns the new record ids in request order, which is how links reference them
  async insertRows(tableId: string, rows: readonly Row[]): Promise<string[]> {
    const ids: string[] = [];
    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
      const chunk = rows.slice(start, start + BATCH_SIZE).map((fields) => ({ fields }));
      const created = await this.call<{ records: { record_id: string }[] }>(
        "POST",
        `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/batch_create`,
        { records: chunk },
      );
      ids.push(...created.records.map((record) => record.record_id));
    }
    return ids;
  }

  async recordTotal(tableId: string): Promise<number> {
    const page = await this.call<{ total?: number }>(
      "POST",
      `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/search?page_size=1`,
      { automatic_fields: false },
    );
    return page.total ?? 0;
  }
}

// #endregion

// #region dataset shape

// generators read earlier tables through the context, so specs stay in dependency order
type SeedContext = {
  ids: Record<string, string[]>;
  rows: Record<string, Row[]>;
};

type TableSpec = {
  name: string;
  seed: number;
  fields: readonly FieldSpec[];
  rows: (rng: Rng, ctx: SeedContext) => Row[];
};

// lark date fields take epoch ms; noon utc keeps the rendered day stable across timezones
function dayOf(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 12);
}

function plusDays(base: number, days: number): number {
  return base + days * 86_400_000;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function urlValue(domain: string): Row {
  return { link: `https://${domain}`, text: domain };
}

// #endregion

// #region northwind: a trading company

const TRADE_PREFIXES = [
  "Meridian",
  "Halcyon",
  "Northgate",
  "Stonebridge",
  "Kestrel",
  "Argent",
  "Blackwood",
  "Fairhaven",
  "Ironvale",
  "Larkspur",
] as const;
const TRADE_NOUNS = ["Trading", "Import", "Commodities"] as const;
const TRADE_SUFFIXES = ["Co", "Group", "Partners", "Ltd", "Holdings"] as const;
const INDUSTRIES = [
  "Wholesale",
  "Retail",
  "Manufacturing",
  "Food & Beverage",
  "Electronics",
  "Textiles",
  "Chemicals",
  "Agriculture",
] as const;
const ACCOUNT_COUNTRIES = ["US", "DE", "FR", "GB", "JP", "SG", "ID", "BR", "CA", "NL", "IT", "AU"] as const;
const FIRST_NAMES = [
  "Casey",
  "Jordan",
  "Riley",
  "Avery",
  "Rowan",
  "Quinn",
  "Sasha",
  "Noor",
  "Diego",
  "Mei",
  "Talia",
  "Omar",
] as const;
const LAST_NAMES = [
  "Brown",
  "Nguyen",
  "Patel",
  "Garcia",
  "Okoro",
  "Ivanov",
  "Suzuki",
  "Haddad",
  "Silva",
  "Kowalski",
  "Ferreira",
  "Lindqvist",
] as const;
const CONTACT_TITLES = [
  "Procurement Manager",
  "Head of Supply",
  "Buyer",
  "Logistics Lead",
  "CFO",
  "Operations Director",
  "Account Manager",
  "Category Buyer",
] as const;
const DEAL_STAGES = ["prospect", "qualified", "proposal", "won", "lost"] as const;
const COMMODITIES = [
  "coffee",
  "cocoa",
  "steel coil",
  "polymer resin",
  "cotton yarn",
  "copper wire",
  "olive oil",
  "rice",
  "aluminium sheet",
  "timber",
] as const;
const DEAL_OWNERS = [
  "Priya Raman",
  "Tomas Weber",
  "Grace Okafor",
  "Hiro Tanaka",
  "Elena Ruiz",
  "Sam Whitfield",
] as const;

const ACCOUNT_COUNT = 30;

function accountDomain(name: string): string {
  const slug = name.toLowerCase().split(" ").slice(0, 2).join("");
  return `${slug}.example`;
}

const northwind: readonly TableSpec[] = [
  {
    name: "accounts",
    seed: 1001,
    fields: [
      { name: "name", type: TEXT },
      { name: "industry", type: SELECT, options: INDUSTRIES },
      { name: "country", type: TEXT },
      { name: "annual_revenue", type: NUMBER },
      { name: "created", type: DATE },
      { name: "website", type: URL },
      { name: "active", type: CHECKBOX },
    ],
    rows: (rng) => {
      const rows: Row[] = [];
      for (let i = 0; i < ACCOUNT_COUNT; i++) {
        // prefix and noun pair uniquely across the 30 rows, so names never collide
        const name = `${TRADE_PREFIXES[i % TRADE_PREFIXES.length]} ${
          TRADE_NOUNS[Math.floor(i / TRADE_PREFIXES.length)]
        } ${rng.pick(TRADE_SUFFIXES)}`;
        rows.push({
          name,
          industry: rng.pick(INDUSTRIES),
          country: rng.pick(ACCOUNT_COUNTRIES),
          annual_revenue: rng.between(20, 4800) * 100_000,
          created: plusDays(dayOf(2015, 1, 1), rng.between(0, 3200)),
          website: urlValue(accountDomain(name)),
          active: rng.chance(0.8),
        });
      }
      return rows;
    },
  },
  {
    name: "contacts",
    seed: 1002,
    fields: [
      { name: "full_name", type: TEXT },
      { name: "email", type: TEXT },
      { name: "phone", type: PHONE },
      { name: "title", type: TEXT },
      { name: "account", type: LINK, target: "accounts" },
    ],
    rows: (rng, ctx) => {
      const rows: Row[] = [];
      for (let i = 0; i < 80; i++) {
        const accountIndex = rng.int(ctx.ids.accounts.length);
        const first = rng.pick(FIRST_NAMES);
        const last = rng.pick(LAST_NAMES);
        const domain = accountDomain(String(ctx.rows.accounts[accountIndex].name));
        rows.push({
          full_name: `${first} ${last}`,
          email: `${first}.${last}${i}@${domain}`.toLowerCase(),
          phone: `+1415555${pad(rng.between(0, 9999), 4)}`,
          title: rng.pick(CONTACT_TITLES),
          account: [ctx.ids.accounts[accountIndex]],
        });
      }
      return rows;
    },
  },
  {
    name: "deals",
    seed: 1003,
    fields: [
      { name: "name", type: TEXT },
      { name: "stage", type: SELECT, options: DEAL_STAGES },
      { name: "amount", type: NUMBER, formatter: "0.00" },
      { name: "close_date", type: DATE },
      { name: "account", type: LINK, target: "accounts" },
      { name: "owner", type: TEXT },
    ],
    rows: (rng, ctx) => {
      const rows: Row[] = [];
      for (let i = 0; i < 60; i++) {
        const accountIndex = rng.int(ctx.ids.accounts.length);
        const shortName = String(ctx.rows.accounts[accountIndex].name).split(" ")[0];
        rows.push({
          name: `${shortName} ${rng.pick(COMMODITIES)} supply ${pad(i + 1, 3)}`,
          stage: rng.pick(DEAL_STAGES),
          amount: rng.between(25_000, 2_400_000) + rng.int(100) / 100,
          close_date: plusDays(dayOf(2024, 1, 1), rng.between(0, 640)),
          account: [ctx.ids.accounts[accountIndex]],
          owner: rng.pick(DEAL_OWNERS),
        });
      }
      return rows;
    },
  },
];

// #endregion

// #region harbor: a logistics company

const VESSEL_NAMES = [
  "MV Coral Meridian",
  "MV Java Trader",
  "MV Baltic Dawn",
  "MV Andaman Star",
  "MV Nordic Ember",
  "MV Celebes Bay",
  "MV Iberian Crest",
  "MV Sunda Voyager",
  "MV Adriatic Pearl",
  "MV Pacific Lantern",
  "MV Aegean Falcon",
  "MV Timor Breeze",
] as const;
const FLAGS = ["PA", "LR", "MH", "SG", "HK", "MT", "CY"] as const;

// name, country, un/locode, iana timezone
const PORTS = [
  ["Singapore", "SG", "SGSIN", "Asia/Singapore"],
  ["Rotterdam", "NL", "NLRTM", "Europe/Amsterdam"],
  ["Shanghai", "CN", "CNSHA", "Asia/Shanghai"],
  ["Busan", "KR", "KRPUS", "Asia/Seoul"],
  ["Hamburg", "DE", "DEHAM", "Europe/Berlin"],
  ["Los Angeles", "US", "USLAX", "America/Los_Angeles"],
  ["Jebel Ali", "AE", "AEJEA", "Asia/Dubai"],
  ["Tanjung Priok", "ID", "IDJKT", "Asia/Jakarta"],
  ["Antwerp", "BE", "BEANR", "Europe/Brussels"],
  ["Hong Kong", "HK", "HKHKG", "Asia/Hong_Kong"],
  ["Yokohama", "JP", "JPYOK", "Asia/Tokyo"],
  ["Santos", "BR", "BRSSZ", "America/Sao_Paulo"],
  ["Felixstowe", "GB", "GBFXT", "Europe/London"],
  ["Port Klang", "MY", "MYPKG", "Asia/Kuala_Lumpur"],
  ["Valencia", "ES", "ESVLC", "Europe/Madrid"],
] as const;

const VOYAGE_STATUSES = ["planned", "at_sea", "arrived", "delayed"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const INCIDENT_PHRASES = [
  "Reefer container temperature excursion",
  "Main engine turbocharger fault",
  "Berth congestion beyond agreed laytime",
  "Cargo lashing failure in bay 34",
  "Heavy weather routing deviation",
  "Bunker quality dispute at last call",
  "Crane breakdown during discharge",
  "Customs hold on three containers",
] as const;

const VOYAGE_COUNT = 90;

const harbor: readonly TableSpec[] = [
  {
    name: "vessels",
    seed: 2001,
    fields: [
      { name: "name", type: TEXT },
      { name: "imo", type: NUMBER },
      { name: "flag", type: SELECT, options: FLAGS },
      { name: "capacity_teu", type: NUMBER },
      { name: "built_year", type: NUMBER },
    ],
    rows: (rng) =>
      VESSEL_NAMES.map((name, i) => ({
        name,
        // spaced blocks keep every imo distinct while staying in the 7-digit range
        imo: 9_000_000 + i * 51_237 + rng.int(1000),
        flag: rng.pick(FLAGS),
        capacity_teu: rng.between(12, 180) * 100,
        built_year: rng.between(1998, 2022),
      })),
  },
  {
    name: "ports",
    seed: 2002,
    fields: [
      { name: "name", type: TEXT },
      { name: "country", type: TEXT },
      { name: "code", type: TEXT },
      { name: "timezone", type: TEXT },
    ],
    rows: () => PORTS.map(([name, country, code, timezone]) => ({ name, country, code, timezone })),
  },
  {
    name: "voyages",
    seed: 2003,
    fields: [
      { name: "voyage_no", type: TEXT },
      { name: "vessel", type: LINK, target: "vessels" },
      { name: "origin", type: LINK, target: "ports" },
      { name: "destination", type: LINK, target: "ports" },
      { name: "departed", type: DATE },
      { name: "arrived", type: DATE },
      { name: "status", type: SELECT, options: VOYAGE_STATUSES },
      { name: "cargo_teu", type: NUMBER },
    ],
    rows: (rng, ctx) => {
      const portCount = ctx.ids.ports.length;
      const rows: Row[] = [];
      for (let i = 0; i < VOYAGE_COUNT; i++) {
        const vesselIndex = rng.int(ctx.ids.vessels.length);
        const capacity = Number(ctx.rows.vessels[vesselIndex].capacity_teu);
        const originIndex = rng.int(portCount);
        // offset guarantees a different port without a rejection loop
        const destinationIndex = (originIndex + 1 + rng.int(portCount - 1)) % portCount;
        const status = rng.pick(VOYAGE_STATUSES);
        const departed = plusDays(dayOf(2024, 1, 1), rng.between(0, 330));
        const row: Row = {
          voyage_no: `HV-24-${pad(i + 1, 3)}`,
          vessel: [ctx.ids.vessels[vesselIndex]],
          origin: [ctx.ids.ports[originIndex]],
          destination: [ctx.ids.ports[destinationIndex]],
          departed,
          status,
          cargo_teu: Math.round((capacity * rng.between(30, 95)) / 1000) * 10,
        };
        // only finished legs carry an arrival; delayed ones land late
        if (status === "arrived") row.arrived = plusDays(departed, rng.between(8, 26));
        if (status === "delayed") row.arrived = plusDays(departed, rng.between(27, 48));
        rows.push(row);
      }
      return rows;
    },
  },
  {
    name: "incidents",
    seed: 2004,
    fields: [
      { name: "description", type: TEXT },
      { name: "voyage", type: LINK, target: "voyages" },
      { name: "reported", type: DATE },
      { name: "severity", type: SELECT, options: SEVERITIES },
    ],
    rows: (rng, ctx) => {
      const sailed = ctx.rows.voyages
        .map((voyage, index) => ({ voyage, index }))
        .filter(({ voyage }) => voyage.status !== "planned");
      const rows: Row[] = [];
      for (let i = 0; i < 20; i++) {
        const { voyage, index } = sailed[rng.int(sailed.length)];
        rows.push({
          description: `${rng.pick(INCIDENT_PHRASES)} on ${voyage.voyage_no}`,
          voyage: [ctx.ids.voyages[index]],
          reported: plusDays(Number(voyage.departed), rng.between(1, 20)),
          severity: rng.pick(SEVERITIES),
        });
      }
      return rows;
    },
  },
];

// #endregion

// #region run

const DATASETS: Record<DatasetName, readonly TableSpec[]> = { northwind, harbor };

async function main(): Promise<void> {
  const datasetName = parseDataset();
  const specs = DATASETS[datasetName];
  const base = new LarkBase();

  const stale = await base.listTables();
  console.log(`base ${APP_TOKEN}: seeding ${datasetName} over ${stale.length} existing table(s)`);

  // a base must always hold one table, and lark rejects duplicate table names,
  // so a uniquely named scratch table carries the base across the wipe
  const scratchId = await base.createTable(`__seed_scratch_${Date.now()}`, [{ name: "name", type: TEXT }], {});
  for (const table of stale) await base.deleteTable(table.table_id);

  const tableIds: Record<string, string> = {};
  for (const spec of specs) tableIds[spec.name] = await base.createTable(spec.name, spec.fields, tableIds);
  await base.deleteTable(scratchId);

  const ctx: SeedContext = { ids: {}, rows: {} };
  for (const spec of specs) {
    const rows = spec.rows(new Rng(spec.seed), ctx);
    ctx.rows[spec.name] = rows;
    ctx.ids[spec.name] = await base.insertRows(tableIds[spec.name], rows);
  }

  for (const spec of specs) {
    console.log(`${spec.name} (${tableIds[spec.name]}): ${await base.recordTotal(tableIds[spec.name])} rows`);
  }
}

await main();

// #endregion
