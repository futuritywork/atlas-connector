import { SQL } from "bun";
import { CONFIG } from "../src/env";

// #region deterministic PRNG — same seed always yields the same probe numbers
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
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
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

// #region row counts (planted)
const COUNTS = {
  owners: 24,
  companies: 2400,
  contacts: 14000,
  deals: 9000,
  activities: 60000,
};
const CONTACT_ORPHANS = 210; // ~1.5% of contacts point at deleted companies (no pg FK)
const CONTACT_EMAIL_DUP_PAIRS = 12; // distinct/nonNull ≈ 13988/14000 = 0.99914, just above 0.999
const COMPANY_CASE_PAIRS = 40; // "Acme Corp" / "ACME CORP" byte-collation fodder
const COMPANY_DOMAIN_DUP_PAIRS = 6;
// #endregion

// #region vocab
const TEAMS = ["AMER", "EMEA", "APAC"] as const;
const INDUSTRIES = [
  "Software",
  "Manufacturing",
  "Retail",
  "Healthcare",
  "Finance",
  "Logistics",
  "Energy",
  "Education",
  "Media",
  "Telecom",
  "Agriculture",
  "Mining",
  "Construction",
  "Hospitality",
  "Automotive",
  "Aerospace",
  "Pharma",
  "Insurance",
  "Real Estate",
  "Consulting",
] as const;
const COUNTRIES = [
  "US",
  "GB",
  "DE",
  "FR",
  "SG",
  "ID",
  "JP",
  "AU",
  "CA",
  "BR",
] as const;
const CURRENCIES = ["USD", "USD", "USD", "USD", "EUR", "IDR"] as const;
const DEAL_STAGES = [
  "prospect",
  "qualified",
  "proposal",
  "negotiation",
  "committed",
  "closed_won",
  "closed_lost",
] as const;
const LIFECYCLE = ["lead", "mql", "sql", "customer", "churned"] as const;
const ACTIVITY_KINDS = ["call", "email", "meeting", "note", "task"] as const;
const TAG_VOCAB = [
  "urgent",
  "follow-up",
  "inbound",
  "outbound",
  "vip",
  "renewal",
  "café",
  "at-risk",
] as const;
const ADJECTIVES = [
  "Acme",
  "Globex",
  "Initech",
  "Umbra",
  "Vertex",
  "Nimbus",
  "Cobalt",
  "Aster",
  "Pinnacle",
  "Harbor",
  "café",
  "Solstice",
] as const;
const NOUNS = [
  "Roasters",
  "Dynamics",
  "Systems",
  "Labs",
  "Foods",
  "Freight",
  "Metals",
  "Media",
  "Health",
  "Robotics",
] as const;
const SUFFIXES = ["Corp", "Inc", "LLC", "Group", "Co"] as const;
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
] as const;
const LAST_NAMES = [
  "Brown",
  "Nguyen",
  "Patel",
  "García",
  "Okoro",
  "Ivanov",
  "Suzuki",
  "Haddad",
  "Silva",
  "Kowalski",
] as const;
const TITLES = [
  "VP Sales",
  "Analyst",
  "Director",
  "Manager",
  "Engineer",
  "Buyer",
  "CFO",
  "Head of Ops",
] as const;
// #endregion

type Cell = string | number | boolean | null;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

// naive UTC timestamp text; the column is `timestamp` (no tz), pg keeps the literal
function isoAt(dayOffset: number, secondsOfDay: number): string {
  const base =
    Date.UTC(2021, 0, 1) + dayOffset * 86_400_000 + secondsOfDay * 1000;
  return new Date(base).toISOString().slice(0, 19);
}

function dateAt(dayOffset: number): string {
  return new Date(Date.UTC(2018, 0, 1) + dayOffset * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function pgArray(items: string[]): string {
  if (items.length === 0) return "{}";
  return `{${items.map((item) => `"${item.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
}

// #region generators
function owners(): Cell[][] {
  const inactive = new Set([5, 12, 19]);
  const rng = new Rng(101);
  const rows: Cell[][] = [];
  for (let id = 1; id <= COUNTS.owners; id++) {
    rows.push([
      id,
      `rep${id}@brightline.example`,
      `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      TEAMS[(id - 1) % TEAMS.length],
      dateAt(rng.between(0, 2400)),
      !inactive.has(id),
    ]);
  }
  return rows;
}

function companies(): Cell[][] {
  const rng = new Rng(202);
  const rows: Cell[][] = [];
  const baseNames: string[] = [];
  for (let i = 0; i < COMPANY_CASE_PAIRS; i++) {
    baseNames.push(
      `${ADJECTIVES[i % ADJECTIVES.length]} ${NOUNS[i % NOUNS.length]} ${SUFFIXES[i % SUFFIXES.length]} ${i + 1}`,
    );
  }

  const domains: (string | null)[] = [];
  for (let id = 1; id <= COUNTS.companies; id++) {
    let name: string;
    if (id <= COMPANY_CASE_PAIRS) {
      name = baseNames[id - 1];
    } else if (id <= COMPANY_CASE_PAIRS * 2) {
      name = baseNames[id - 1 - COMPANY_CASE_PAIRS].toUpperCase(); // the case twin
    } else {
      name = `${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)} ${rng.pick(SUFFIXES)} ${id}`;
    }
    if (id % 500 === 0) name = `${name} `; // a few trailing-space blemishes

    const domain = rng.chance(0.05) ? null : `acct${id}.example`;
    domains.push(domain);

    rows.push([
      id,
      name,
      domain,
      rng.pick(INDUSTRIES),
      rng.chance(0.1) ? null : rng.between(5, 50_000),
      rng.chance(0.2) ? null : (rng.float() * 1e7).toFixed(2),
      rng.pick(COUNTRIES),
      rng.chance(0.15) ? null : `ACCT-${pad(id, 6)}`,
      isoAt(rng.between(0, 1460), rng.between(0, 86_399)),
    ]);
  }

  // plant exactly COMPANY_DOMAIN_DUP_PAIRS duplicate domains among the non-null values
  const withDomain = rows.filter((row) => row[2] !== null);
  for (let k = 0; k < COMPANY_DOMAIN_DUP_PAIRS; k++) {
    const a = withDomain[k * 40 + 10];
    const b = withDomain[k * 40 + 20];
    if (a && b) b[2] = a[2];
  }
  return rows;
}

function contacts(): Cell[][] {
  const rng = new Rng(303);
  const rows: Cell[][] = [];
  for (let id = 1; id <= COUNTS.contacts; id++) {
    const titleRoll = rng.float();
    const title =
      titleRoll < 0.05 ? "" : titleRoll < 0.3 ? null : rng.pick(TITLES);
    rows.push([
      id,
      rng.between(1, COUNTS.companies), // valid company by default; orphans planted below
      `contact${id}@ex.example`,
      rng.pick(FIRST_NAMES),
      rng.pick(LAST_NAMES),
      title,
      rng.chance(0.3) ? null : `+1${pad(rng.between(0, 9_999_999), 7)}`,
      rng.pick(LIFECYCLE),
      isoAt(rng.between(0, 540), rng.between(0, 86_399)),
    ]);
  }

  // exactly CONTACT_ORPHANS company_ids point at non-existent companies (ids well past the max)
  for (let k = 0; k < CONTACT_ORPHANS; k++) {
    rows[k * 66][1] = 900_000 + k;
  }
  // exactly CONTACT_EMAIL_DUP_PAIRS duplicate email pairs → distinct = 14000 - 12
  for (let k = 0; k < CONTACT_EMAIL_DUP_PAIRS; k++) {
    rows[1000 + k * 500][2] = rows[900 + k * 500][2];
  }
  return rows;
}

function deals(): Cell[][] {
  const rng = new Rng(404);
  const rows: Cell[][] = [];
  for (let id = 1; id <= COUNTS.deals; id++) {
    const stage = rng.pick(DEAL_STAGES);
    const closed = stage === "closed_won" || stage === "closed_lost";
    let amount: string | null = null;
    if (id === 1) {
      amount = "9007199254740993.01"; // > 2^53 sentinel: exact only if rendered as text
    } else if (!rng.chance(0.08)) {
      const whole = rng.between(500, 5_000_000);
      // a subset carries a 3-decimal scale spelling ("1234.500") beside the 2-decimal norm
      amount = rng.chance(0.05)
        ? `${whole}.500`
        : `${whole}.${pad(rng.between(0, 99), 2)}`;
    }
    rows.push([
      id,
      rng.between(1, COUNTS.companies),
      rng.chance(0.15) ? null : rng.between(1, COUNTS.contacts),
      rng.between(1, COUNTS.owners),
      `Deal ${id}`,
      stage,
      amount,
      rng.pick(CURRENCIES),
      dateAt(rng.between(1200, 2600)),
      closed ? isoAt(rng.between(400, 1400), rng.between(0, 86_399)) : null,
      isoAt(rng.between(0, 1400), rng.between(0, 86_399)),
    ]);
  }
  return rows;
}

function activities(): Cell[][] {
  const rng = new Rng(505);
  const rows: Cell[][] = [];
  for (let id = 1; id <= COUNTS.activities; id++) {
    const kind = rng.pick(ACTIVITY_KINDS);
    const tags: string[] = [];
    const tagCount = rng.int(3);
    for (let i = 0; i < tagCount; i++) tags.push(rng.pick(TAG_VOCAB));
    if (id % 10 === 0 && !tags.includes("urgent")) tags.push("urgent"); // guarantee `contains` has hits

    const subjectRoll = rng.float();
    const subject =
      subjectRoll < 0.03
        ? ""
        : subjectRoll < 0.06
          ? "café meeting"
          : subjectRoll < 0.09
            ? "Follow up " // trailing-space twin of "Follow up"
            : subjectRoll < 0.12
              ? "Follow up"
              : `Subject ${id}`;

    rows.push([
      id,
      rng.chance(0.7) ? rng.between(1, COUNTS.deals) : null,
      rng.chance(0.6) ? rng.between(1, COUNTS.contacts) : null,
      rng.between(1, COUNTS.owners),
      kind,
      subject,
      pgArray(tags),
      isoAt(rng.between(0, 540), rng.between(0, 86_399)),
      kind === "call" ? rng.between(1, 120) : null,
    ]);
  }
  return rows;
}
// #endregion

const DDL = `
DROP SCHEMA IF EXISTS ${CONFIG.schema} CASCADE;
CREATE SCHEMA ${CONFIG.schema};

CREATE TABLE ${CONFIG.schema}.owners (
  id bigint PRIMARY KEY,
  email text NOT NULL UNIQUE,
  full_name text NOT NULL,
  team text NOT NULL,
  hired_on date NOT NULL,
  active boolean NOT NULL
);
COMMENT ON TABLE ${CONFIG.schema}.owners IS 'Sales representatives.';

CREATE TABLE ${CONFIG.schema}.companies (
  id bigint PRIMARY KEY,
  name text NOT NULL,
  domain text,
  industry text NOT NULL,
  employee_count integer,
  annual_revenue numeric(14,2),
  billing_country text NOT NULL,
  erp_account_code text,
  created_at timestamp NOT NULL
);
COMMENT ON COLUMN ${CONFIG.schema}.companies.erp_account_code IS 'External ERP account id; the cross-source join key.';

CREATE TABLE ${CONFIG.schema}.contacts (
  id bigint PRIMARY KEY,
  company_id bigint,
  email text,
  first_name text NOT NULL,
  last_name text NOT NULL,
  title text,
  phone text,
  lifecycle_stage text NOT NULL,
  created_at timestamp NOT NULL
);

CREATE TABLE ${CONFIG.schema}.deals (
  id bigint PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES ${CONFIG.schema}.companies(id),
  primary_contact_id bigint REFERENCES ${CONFIG.schema}.contacts(id),
  owner_id bigint NOT NULL REFERENCES ${CONFIG.schema}.owners(id),
  name text NOT NULL,
  stage text NOT NULL,
  amount numeric,
  currency text NOT NULL,
  expected_close date,
  closed_at timestamp,
  created_at timestamp NOT NULL
);

CREATE TABLE ${CONFIG.schema}.activities (
  id bigint PRIMARY KEY,
  deal_id bigint,
  contact_id bigint,
  owner_id bigint NOT NULL REFERENCES ${CONFIG.schema}.owners(id),
  kind text NOT NULL,
  subject text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  occurred_at timestamp NOT NULL,
  duration_minutes integer
);
`;

async function insertRows(
  sql: SQL,
  table: string,
  columns: string[],
  rows: Cell[][],
): Promise<void> {
  const chunkSize = 1000;
  const colList = columns.map((c) => `"${c}"`).join(", ");
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const params: Cell[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await sql.unsafe(
      `INSERT INTO ${CONFIG.schema}.${table} (${colList}) VALUES ${tuples.join(", ")}`,
      params,
    );
  }
}

async function ensureDatabase(): Promise<void> {
  const target = new URL(CONFIG.databaseUrl);
  const dbName = target.pathname.replace(/^\//, "");
  const admin = new URL(CONFIG.databaseUrl);
  admin.pathname = "/postgres";
  const sql = new SQL(admin.toString());
  try {
    await sql.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    console.log(`created database ${dbName}`);
  } catch (error) {
    if (!String((error as Error).message).includes("already exists"))
      throw error;
  } finally {
    await sql.close();
  }
}

async function main(): Promise<void> {
  await ensureDatabase();
  const sql = new SQL(CONFIG.databaseUrl);
  try {
    await sql.unsafe(DDL);
    await insertRows(
      sql,
      "owners",
      ["id", "email", "full_name", "team", "hired_on", "active"],
      owners(),
    );
    await insertRows(
      sql,
      "companies",
      [
        "id",
        "name",
        "domain",
        "industry",
        "employee_count",
        "annual_revenue",
        "billing_country",
        "erp_account_code",
        "created_at",
      ],
      companies(),
    );
    await insertRows(
      sql,
      "contacts",
      [
        "id",
        "company_id",
        "email",
        "first_name",
        "last_name",
        "title",
        "phone",
        "lifecycle_stage",
        "created_at",
      ],
      contacts(),
    );
    await insertRows(
      sql,
      "deals",
      [
        "id",
        "company_id",
        "primary_contact_id",
        "owner_id",
        "name",
        "stage",
        "amount",
        "currency",
        "expected_close",
        "closed_at",
        "created_at",
      ],
      deals(),
    );
    await insertRows(
      sql,
      "activities",
      [
        "id",
        "deal_id",
        "contact_id",
        "owner_id",
        "kind",
        "subject",
        "tags",
        "occurred_at",
        "duration_minutes",
      ],
      activities(),
    );

    for (const table of [
      "owners",
      "companies",
      "contacts",
      "deals",
      "activities",
    ]) {
      const [row] = await sql.unsafe(
        `SELECT COUNT(*)::int AS n FROM ${CONFIG.schema}.${table}`,
      );
      console.log(`${table}: ${(row as { n: number }).n}`);
    }
  } finally {
    await sql.close();
  }
}

await main();
