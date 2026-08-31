import { describe, expect, test } from "bun:test";
import type { AggregateSourceQueryWire } from "../wire/schemas";
import { OPS } from "../wire/vocabulary";
import { buildAggregate, renderAggregateRows } from "./aggregate";
import { type Column, defineCatalog, type Table } from "./catalog";
import { postgres, type SqlContext } from "./flavor";

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
  foreignKeys: [{ field: "customer_id", targetTable: "customers", targetField: "id" }],
  columns: [
    column("id", "int", { type: "number", unique: true }),
    column("customer_id", "int", { type: "number" }),
    column("status", "text"),
    column("total", "decimal", { type: "decimal" }),
    column("tags", "text_array", { type: "array" }),
    column("created_at", "datetime", { type: "datetime" }),
  ],
};

const customers: Table = {
  name: "customers",
  description: "",
  primaryKey: ["id"],
  foreignKeys: [],
  columns: [
    column("id", "int", { type: "number", unique: true }),
    column("name", "text"),
    column("region", "text"),
  ],
};

const catalog = defineCatalog([orders, customers]);

const ctx: SqlContext = {
  catalog,
  schema: "public",
  flavor: postgres(),
  operators: new Set(OPS),
};

const aggQuery = (over?: Partial<AggregateSourceQueryWire>): AggregateSourceQueryWire => ({
  table: "orders",
  and: [],
  groupBy: [],
  measures: [{ fn: "count", as: "n" }],
  stringFields: [],
  ...over,
});

const customerJoin = (toField: string) => [
  {
    fromTable: "orders",
    toTable: "customers",
    fromField: "customer_id",
    toField,
    fields: [{ field: "region", type: "string" as const, as: "region" }],
  },
];

describe("buildAggregate declines", () => {
  test("declines a join onto a non-unique key", () => {
    expect(buildAggregate(ctx, aggQuery({ joins: customerJoin("region") }), 10)).toBeNull();
  });

  test("declines count over a text_array field", () => {
    const query = aggQuery({ measures: [{ fn: "count", field: "tags", as: "n" }] });
    expect(buildAggregate(ctx, query, 10)).toBeNull();
  });

  test("declines count_distinct over a text_array field", () => {
    const query = aggQuery({ measures: [{ fn: "count_distinct", field: "tags", as: "n" }] });
    expect(buildAggregate(ctx, query, 10)).toBeNull();
  });

  test("declines sum over a non-numeric field", () => {
    const query = aggQuery({ measures: [{ fn: "sum", field: "status", as: "s" }] });
    expect(buildAggregate(ctx, query, 10)).toBeNull();
  });

  test("declines min over a text_array field", () => {
    const query = aggQuery({ measures: [{ fn: "min", field: "tags", as: "m" }] });
    expect(buildAggregate(ctx, query, 10)).toBeNull();
  });
});

describe("buildAggregate pushdown", () => {
  test("bare count(*) with the group-row limit", () => {
    const built = buildAggregate(ctx, aggQuery(), 7);
    expect(built).not.toBeNull();
    expect(built?.sql).toContain('COUNT(*)::bigint AS "n"');
    expect(built?.sql).toContain("LIMIT 7");
    expect(built?.sql).not.toContain("GROUP BY");
    expect(built?.columns).toEqual([{ key: "n", expr: "COUNT(*)::bigint", wire: "int" }]);
  });

  test("pushes a unique-keyed same-source join down and groups on the hop field", () => {
    const query = aggQuery({
      joins: customerJoin("id"),
      groupBy: [{ field: "region", as: "region" }],
    });
    const built = buildAggregate(ctx, query, 10);
    expect(built).not.toBeNull();
    expect(built?.sql).toContain("LEFT JOIN");
    expect(built?.sql).toContain('t1."region"');
    expect(built?.sql).toContain("GROUP BY");
  });

  test("grain groups bucket through the flavor's dateTrunc", () => {
    const query = aggQuery({ groupBy: [{ field: "created_at", as: "month", grain: "month" }] });
    const built = buildAggregate(ctx, query, 10);
    expect(built?.sql).toContain(`to_char(date_trunc('month', t0."created_at"), 'YYYY-MM-DD')`);
    expect(built?.columns[0]?.wire).toBe("text");
  });

  test("decimal groups and sums cross as exact text", () => {
    const query = aggQuery({
      groupBy: [{ field: "total", as: "total" }],
      measures: [{ fn: "sum", field: "total", as: "s" }],
    });
    const built = buildAggregate(ctx, query, 10);
    expect(built?.sql).toContain('t0."total"::text');
    expect(built?.sql).toContain('SUM(t0."total")::text');
    expect(built?.columns.map((c) => c.wire)).toEqual(["decimal", "decimal"]);
  });

  test("string-typed group keys are byte-pinned", () => {
    const query = aggQuery({
      groupBy: [{ field: "status", as: "status" }],
      stringFields: ["status"],
    });
    const built = buildAggregate(ctx, query, 10);
    expect(built?.sql).toContain('t0."status" COLLATE "C"');
  });

  test("filters bind through the where builder", () => {
    const query = aggQuery({ and: [{ field: "status", op: "eq", value: "paid" }] });
    const built = buildAggregate(ctx, query, 10);
    expect(built?.sql).toContain("WHERE");
    expect(built?.params).toEqual(["paid"]);
  });
});

describe("renderAggregateRows", () => {
  test("renders each out column by its wire kind", () => {
    const rows = [{ month: "2026-01-01", n: "12", s: "99.50" }];
    const columns = [
      { key: "month", expr: "x", wire: "text" as const },
      { key: "n", expr: "x", wire: "int" as const },
      { key: "s", expr: "x", wire: "decimal" as const },
    ];
    expect(renderAggregateRows(rows, columns)).toEqual([{ month: "2026-01-01", n: 12, s: "99.50" }]);
  });
});
