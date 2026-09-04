import { describe, expect, test } from "bun:test";
import { AtlasConnector } from "./connector";
import type { AtlasJson } from "./wire/atlas-json";
import type { DiscoveryAnswer, NativeQueryRequest } from "./wire/schemas";
import type { SourceRow } from "./wire/vocabulary";

const DOC: AtlasJson = {
  protocolVersion: 1,
  slug: "minimal-test",
  capabilities: {
    operators: ["eq"],
    dateBucket: false,
    sort: "none",
    offset: false,
    count: "server",
    join: false,
    enforcesDeclaredKeys: false,
    probeConcurrency: 4,
    cheapProbes: false,
  },
  credentialSchema: [{ key: "apiKey", label: "API key", type: "password", required: true }],
  endpoints: [],
};

const TABLES: Record<string, SourceRow[]> = {
  orders: [
    { id: 1, customer_id: 7 },
    { id: 2, customer_id: 7 },
    { id: 3, customer_id: null },
  ],
  customers: [{ id: 7 }],
  prices: [{ amount: 10 }, { amount: 2 }, { amount: 10 }],
};

class Minimal extends AtlasConnector {
  readonly slug = "minimal-test";
  readonly seen: NativeQueryRequest[] = [];
  capability(): AtlasJson {
    return DOC;
  }
  async check(): Promise<void> {}
  async discover(): Promise<DiscoveryAnswer> {
    return { tables: [] };
  }
  async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    this.seen.push(req);
    const rows = TABLES[req.table] ?? [];
    yield rows.map((row) => Object.fromEntries(req.fields.map((field) => [field, row[field] ?? null])));
  }
  async count(): Promise<number> {
    return 0;
  }
}

const credentials = { apiKey: "k" };
const deadline = { credentials, timeoutMs: 1000 };

describe("AtlasConnector derived profiling", () => {
  test("exactCount counts the rows query() yields", async () => {
    const connector = new Minimal();
    expect(await connector.exactCount({ table: "orders", ...deadline })).toBe(3);
    expect(connector.seen[0]?.fields).toEqual([]);
  });

  test("profileColumns counts per column the way the sql probe would", async () => {
    const probe = await new Minimal().profileColumns({
      table: "orders",
      columns: ["id", "customer_id"],
      ...deadline,
    });
    expect(probe).toEqual({
      rows: 3,
      columns: {
        id: { nonNull: 3, distinct: 3, duplicates: { valueCount: 0, maxMultiplicity: 1 } },
        customer_id: { nonNull: 2, distinct: 1, duplicates: null },
      },
    });
  });

  test("profileGrain counts rows, non-nulls, and distincts", async () => {
    const probe = await new Minimal().profileGrain({
      table: "orders",
      column: "customer_id",
      ...deadline,
    });
    expect(probe).toEqual({ rows: 3, distinct: 1, nonNull: 2 });
  });

  test("profileLink scans both sides for orphans", async () => {
    const probe = await new Minimal().profileLink({
      fromTable: "orders",
      fromColumn: "customer_id",
      toTable: "customers",
      toColumn: "id",
      ...deadline,
    });
    expect(probe).toEqual({ fromNonNull: 2, orphanCount: 0, orphanRate: 0, orphanSamples: [] });
  });

  test("sampleColumnValues answers the distinct head, numbers by magnitude", async () => {
    const values = await new Minimal().sampleColumnValues({
      table: "prices",
      column: "amount",
      type: "number",
      limit: 5,
      ...deadline,
    });
    expect(values).toEqual(["2", "10"]);
  });

  test("the tenant's credentials and deadline reach query()", async () => {
    const connector = new Minimal();
    await connector.profileGrain({ table: "orders", column: "id", ...deadline });
    expect(connector.seen[0]?.credentials).toEqual(credentials);
    expect(connector.seen[0]?.timeoutMs).toBe(1000);
  });
});

describe("AtlasConnector base impls", () => {
  test("aggregate declines with undefined", async () => {
    expect(
      await new Minimal().aggregate({
        table: "t",
        and: [],
        groupBy: [],
        measures: [],
        stringFields: [],
        limit: 10,
        ...deadline,
      }),
    ).toBeUndefined();
  });
});
