import { describe, expect, test } from "bun:test";
import type { SourceQueryWire } from "../wire/schemas";
import { OPS } from "../wire/vocabulary";
import { ConnectorError } from "../serve/errors";
import { col, defineCatalog } from "./catalog";
import { postgres, type SqlContext } from "./flavor";
import { buildCount, buildSelect, renderRows } from "./select";

const catalog = defineCatalog([
  {
    name: "companies",
    description: "",
    primaryKey: ["id"],
    foreignKeys: [],
    columns: [
      col("id", "int", "number"),
      col("name", "text", "string"),
      col("annual_revenue", "decimal", "decimal", { nullable: true }),
      col("founded_on", "date", "date"),
      col("created_at", "datetime", "datetime"),
    ],
  },
  {
    name: "contacts",
    description: "",
    primaryKey: ["id"],
    foreignKeys: [{ field: "company_id", targetTable: "companies", targetField: "id" }],
    columns: [
      col("id", "int", "number"),
      col("company_id", "int", "number", { nullable: true }),
      col("email", "text", "string", { nullable: true }),
    ],
  },
]);

const ctx: SqlContext = {
  catalog,
  schema: "crm",
  flavor: postgres(),
  operators: new Set(OPS),
};

function query(partial: Partial<SourceQueryWire> & Pick<SourceQueryWire, "table" | "fields">): SourceQueryWire {
  return { and: [], sort: [], ...partial };
}

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ConnectorError ? error.status : null;
  }
}

describe("buildSelect", () => {
  test("plain projection off the aliased base table", () => {
    const { sql, params } = buildSelect(ctx, query({ table: "companies", fields: ["id", "name"] }));
    expect(sql).toBe(`SELECT t0."id" AS "id", t0."name" AS "name" FROM "crm"."companies" AS t0`);
    expect(params).toEqual([]);
  });

  test("decimal, date and datetime render server-side", () => {
    const { sql } = buildSelect(
      ctx,
      query({ table: "companies", fields: ["annual_revenue", "founded_on", "created_at"] }),
    );
    expect(sql).toBe(
      `SELECT t0."annual_revenue"::text AS "annual_revenue", ` +
        `to_char(t0."founded_on", 'YYYY-MM-DD') AS "founded_on", ` +
        `to_char(t0."created_at", 'YYYY-MM-DD"T"HH24:MI:SS') AS "created_at" ` +
        `FROM "crm"."companies" AS t0`,
    );
  });

  test("a hop LEFT JOINs as t1 and projects under its alias", () => {
    const { sql } = buildSelect(
      ctx,
      query({
        table: "contacts",
        fields: ["id"],
        joins: [
          {
            fromTable: "contacts",
            toTable: "companies",
            fromField: "company_id",
            toField: "id",
            fields: [{ field: "name", as: "company_name", type: "string" }],
          },
        ],
      }),
    );
    expect(sql).toBe(
      `SELECT t0."id" AS "id", t1."name" AS "company_name" FROM "crm"."contacts" AS t0 ` +
        `LEFT JOIN "crm"."companies" AS t1 ON t0."company_id" = t1."id"`,
    );
  });

  test("where, collated sort, NULLS LAST and the window compose in order", () => {
    const { sql, params } = buildSelect(
      ctx,
      query({
        table: "companies",
        fields: ["id"],
        and: [{ field: "name", op: "startswith", value: "A" }],
        sort: [
          { field: "name", dir: "asc", collate: true },
          { field: "id", dir: "desc" },
        ],
        limit: 10,
        offset: 20,
      }),
    );
    expect(sql).toBe(
      `SELECT t0."id" AS "id" FROM "crm"."companies" AS t0 ` +
        `WHERE t0."name"::text LIKE $1 ESCAPE '\\' ` +
        `ORDER BY t0."name" COLLATE "C" ASC NULLS LAST, t0."id" DESC NULLS LAST ` +
        `LIMIT 10 OFFSET 20`,
    );
    expect(params).toEqual(["A%"]);
  });

  test("collate on a non-string sort stays unpinned", () => {
    const { sql } = buildSelect(
      ctx,
      query({ table: "companies", fields: ["id"], sort: [{ field: "id", dir: "asc", collate: true }] }),
    );
    expect(sql).toBe(
      `SELECT t0."id" AS "id" FROM "crm"."companies" AS t0 ORDER BY t0."id" ASC NULLS LAST`,
    );
  });

  test("selecting no fields is a bad request", () => {
    expect(statusOf(() => buildSelect(ctx, query({ table: "companies", fields: [] })))).toBe(400);
  });

  test("an unknown table is an unknown entity", () => {
    expect(statusOf(() => buildSelect(ctx, query({ table: "nope", fields: ["id"] })))).toBe(404);
  });
});

describe("buildCount", () => {
  test("counts with the where, ignoring projection and window", () => {
    const { sql, params } = buildCount(ctx, {
      table: "companies",
      and: [{ field: "id", op: "eq", value: 5 }],
    });
    expect(sql).toBe(
      `SELECT COUNT(*)::bigint AS count FROM "crm"."companies" AS t0 WHERE t0."id" = $1::numeric`,
    );
    expect(params).toEqual(["5"]);
  });

  test("no filters trims to a bare count", () => {
    const { sql } = buildCount(ctx, { table: "companies", and: [] });
    expect(sql).toBe(`SELECT COUNT(*)::bigint AS count FROM "crm"."companies" AS t0`);
  });
});

describe("renderRows", () => {
  test("renders each cell by its column's wire kind", () => {
    const { columns } = buildSelect(
      ctx,
      query({ table: "companies", fields: ["id", "name", "annual_revenue"] }),
    );
    const rows = renderRows(
      [
        { id: 5, name: 42, annual_revenue: "10.250" },
        { id: "9007199254740993", name: "acme", annual_revenue: null },
      ],
      columns,
    );
    expect(rows).toEqual([
      { id: 5, name: "42", annual_revenue: "10.250" },
      { id: "9007199254740993", name: "acme", annual_revenue: null },
    ]);
  });
});
