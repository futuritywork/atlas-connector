import { describe, expect, test } from "bun:test";
import { OPS } from "../wire/vocabulary";
import { col, defineCatalog, type Table } from "./catalog";
import { postgres, type SqlContext } from "./flavor";
import { cardinality, linkHitRate, size } from "./measure";
import type { Row } from "./sql-connector";

const orders: Table = {
  name: "orders",
  description: "",
  primaryKey: ["id"],
  foreignKeys: [],
  columns: [
    col("id", "int", "number", { unique: true }),
    col("customer_id", "int", "number", { nullable: true }),
    col("sku", "text", "string", { nullable: true }),
    col("total", "decimal", "decimal", { nullable: true }),
  ],
};

const customers: Table = {
  name: "customers",
  description: "",
  primaryKey: ["id"],
  foreignKeys: [],
  columns: [col("id", "int", "number", { unique: true }), col("name", "text", "string")],
};

const catalog = defineCatalog([orders, customers]);

const ctx: SqlContext = {
  catalog,
  schema: "public",
  flavor: postgres(),
  operators: new Set(OPS),
};

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

// the runner is canned, so nothing ever opens a pool
const authed = { credentials: {}, timeoutMs: 1000 };

describe("cardinality", () => {
  test("unique, non-unique, and empty columns from one aggregate scan", async () => {
    const { run, calls } = runnerOf([[{ nn_0: 10, d_0: 10, nn_1: 8, d_1: 4, nn_2: 0, d_2: 0 }]]);
    const counts = await cardinality(ctx, run, {
      table: "orders",
      columns: ["id", "customer_id", "sku"],
      ...authed,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.sql).toContain('COUNT(DISTINCT "id")');
    expect(counts).toEqual({
      id: { nonNull: 10, distinct: 10 },
      customer_id: { nonNull: 8, distinct: 4 },
      sku: { nonNull: 0, distinct: 0 },
    });
  });

  test("a column outside the catalog is refused, never counted as zero", async () => {
    const { run } = runnerOf([]);
    const counting = cardinality(ctx, run, { table: "orders", columns: ["nope"], ...authed });
    await expect(counting).rejects.toThrow();
  });
});

describe("linkHitRate", () => {
  test("orphan math over a distinct-collapsed target", async () => {
    const { run, calls } = runnerOf([
      [{ from_non_null: 10, orphan_count: 2 }],
      [{ v: "77" }, { v: "78" }],
    ]);
    const link = await linkHitRate(ctx, run, {
      fromTable: "orders",
      fromColumn: "customer_id",
      toTable: "customers",
      toColumn: "id",
      ...authed,
    });
    expect(link).toEqual({
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
    const link = await linkHitRate(ctx, run, {
      fromTable: "orders",
      fromColumn: "customer_id",
      toTable: "customers",
      toColumn: "id",
      ...authed,
    });
    expect(link.orphanRate).toBe(0);
    expect(link.orphanSamples).toEqual([]);
    expect(calls.length).toBe(1);
  });
});

describe("size", () => {
  test("a bigint count comes back as a number, exact true", async () => {
    const { run, calls } = runnerOf([[{ count: "7" }]]);
    expect(await size(ctx, run, { table: "orders", ...authed })).toEqual({ rows: 7, exact: true });
    expect(calls[0]?.sql).toContain("COUNT(*)::bigint");
  });
});
