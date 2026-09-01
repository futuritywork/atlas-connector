import { describe, expect, test } from "bun:test";
import { OPS } from "../wire/vocabulary";
import { type Column, defineCatalog, type Table } from "./catalog";
import { postgres, type SqlContext } from "./flavor";
import { countExact, probeColumns, probeGrain, probeLink, sampleKeyValues } from "./probes";
import type { Row } from "./sql-connector";

const column = (name: string, wire: Column["wire"], over?: Partial<Column>): Column => ({
  name,
  wire,
  type: "string",
  nullable: true,
  unique: false,
  description: "",
  ...over,
});

const orders: Table = {
  name: "orders",
  description: "",
  primaryKey: ["id"],
  foreignKeys: [],
  columns: [
    column("id", "int", { type: "number", unique: true }),
    column("customer_id", "int", { type: "number" }),
    column("sku", "text"),
    column("total", "decimal", { type: "decimal" }),
  ],
};

const customers: Table = {
  name: "customers",
  description: "",
  primaryKey: ["id"],
  foreignKeys: [],
  columns: [column("id", "int", { type: "number", unique: true }), column("name", "text")],
};

const catalog = defineCatalog([orders, customers]);

const ctx: SqlContext = {
  catalog,
  schema: "public",
  flavor: postgres(),
  operators: new Set(OPS),
};

// canned-result runner: each call pops the next result and records the sql it was asked
function runnerOf(results: Row[][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const run = (sql: string, params: unknown[]): Promise<Row[]> => {
    calls.push({ sql, params });
    const result = results[calls.length - 1];
    if (!result) throw new Error(`unexpected query #${calls.length}: ${sql}`);
    return Promise.resolve(result);
  };
  return { run, calls };
}

// credentials are the pool's concern, not the probe sql's
const deadline = { credentials: {}, timeoutMs: 1000 };

describe("probeColumns", () => {
  test("unique, non-unique, and empty columns from one aggregate scan", async () => {
    const { run, calls } = runnerOf([
      [{ rows: 10, nn_0: 10, d_0: 10, nn_1: 8, d_1: 4, nn_2: 0, d_2: 0 }],
    ]);
    const probe = await probeColumns(ctx, run, {
      table: "orders",
      columns: ["id", "customer_id", "sku"],
      ...deadline,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.sql).toContain('COUNT(DISTINCT "id")');
    expect(probe.rows).toBe(10);
    expect(probe.columns.id).toEqual({
      nonNull: 10,
      distinct: 10,
      duplicates: { valueCount: 0, maxMultiplicity: 1 },
    });
    // below the near-unique floor the distinct count already refutes the key
    expect(probe.columns.customer_id).toEqual({ nonNull: 8, distinct: 4, duplicates: null });
    expect(probe.columns.sku).toEqual({
      nonNull: 0,
      distinct: 0,
      duplicates: { valueCount: 0, maxMultiplicity: 1 },
    });
  });

  test("a near-unique column enumerates its blemishes byte-ordered", async () => {
    const { run, calls } = runnerOf([
      [{ rows: 1000, nn_0: 1000, d_0: 999 }],
      [{ dupvals: 1, maxmult: 2 }],
      [{ v: "A-7" }],
    ]);
    const probe = await probeColumns(ctx, run, { table: "orders", columns: ["sku"], ...deadline });
    expect(probe.columns.sku).toEqual({
      nonNull: 1000,
      distinct: 999,
      duplicates: { valueCount: 1, maxMultiplicity: 2, samples: ["A-7"] },
    });
    expect(calls[2]?.sql).toContain('ORDER BY v COLLATE "C"');
    expect(calls[2]?.sql).toContain("LIMIT 100");
  });
});

describe("probeLink", () => {
  test("orphan math over a distinct-collapsed target", async () => {
    const { run, calls } = runnerOf([
      [{ from_non_null: 10, orphan_count: 2 }],
      [{ v: "77" }, { v: "78" }],
    ]);
    const probe = await probeLink(ctx, run, {
      fromTable: "orders",
      fromColumn: "customer_id",
      toTable: "customers",
      toColumn: "id",
      ...deadline,
    });
    expect(probe).toEqual({
      fromNonNull: 10,
      orphanCount: 2,
      orphanRate: 0.2,
      orphanSamples: ["77", "78"],
    });
    expect(calls[0]?.sql).toContain("SELECT DISTINCT");
    expect(calls[1]?.sql).toContain("LIMIT 20");
  });

  test("no orphans skips the sample query", async () => {
    const { run, calls } = runnerOf([[{ from_non_null: 10, orphan_count: 0 }]]);
    const probe = await probeLink(ctx, run, {
      fromTable: "orders",
      fromColumn: "customer_id",
      toTable: "customers",
      toColumn: "id",
      ...deadline,
    });
    expect(probe.orphanRate).toBe(0);
    expect(probe.orphanSamples).toEqual([]);
    expect(calls.length).toBe(1);
  });
});

describe("probeGrain", () => {
  test("rows, non-null, and distinct from one scan", async () => {
    const { run } = runnerOf([[{ rows: 5, non_null: 4, distinct_count: 3 }]]);
    const probe = await probeGrain(ctx, run, { table: "orders", column: "sku", ...deadline });
    expect(probe).toEqual({ rows: 5, nonNull: 4, distinct: 3 });
  });
});

describe("countExact", () => {
  test("exact bigint count crosses as a number", async () => {
    const { run, calls } = runnerOf([[{ count: "7" }]]);
    expect(await countExact(ctx, run, { table: "orders", ...deadline })).toBe(7);
    expect(calls[0]?.sql).toContain("COUNT(*)::bigint");
  });
});

describe("sampleKeyValues", () => {
  test("string keys sort and project byte-pinned", async () => {
    const { run, calls } = runnerOf([[{ v: "a" }, { v: null }, { v: "" }, { v: "b" }]]);
    const values = await sampleKeyValues(ctx, run, {
      table: "orders",
      column: "sku",
      type: "string",
      limit: 4,
      ...deadline,
    });
    expect(values).toEqual(["a", "b"]);
    expect(calls[0]?.sql).toContain('COLLATE "C"');
    expect(calls[0]?.sql).toContain("LIMIT 4");
  });

  test("non-string keys sort by magnitude on the bare column", async () => {
    const { run, calls } = runnerOf([[{ v: 2 }, { v: 10 }]]);
    const values = await sampleKeyValues(ctx, run, {
      table: "orders",
      column: "id",
      type: "number",
      limit: 2,
      ...deadline,
    });
    expect(values).toEqual(["2", "10"]);
    expect(calls[0]?.sql).not.toContain("COLLATE");
  });
});
