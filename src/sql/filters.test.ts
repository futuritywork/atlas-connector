import { describe, expect, test } from "bun:test";
import { OPS } from "../wire/vocabulary";
import { ConnectorError } from "../serve/errors";
import { col, defineCatalog } from "./catalog";
import { Binder, buildWhere } from "./filters";
import { postgres, type SqlContext } from "./flavor";

const catalog = defineCatalog([
  {
    name: "deals",
    description: "",
    primaryKey: ["id"],
    foreignKeys: [],
    columns: [
      col("id", "int", "number"),
      col("amount", "decimal", "decimal", { nullable: true }),
      col("name", "text", "string"),
      col("stage", "text", "string"),
      col("tags", "text_array", "array"),
      col("closed_at", "datetime", "datetime", { nullable: true }),
    ],
  },
]);

const ctx: SqlContext = {
  catalog,
  schema: "crm",
  flavor: postgres(),
  operators: new Set(OPS),
};

const deals = catalog.getTable("deals")!;

function where(and: Parameters<typeof buildWhere>[2], or?: Parameters<typeof buildWhere>[3]) {
  const binder = new Binder(ctx.flavor);
  return { sql: buildWhere(ctx, deals, and, or, binder), params: binder.params };
}

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ConnectorError ? error.status : null;
  }
}

describe("buildWhere", () => {
  test("no filters renders no WHERE", () => {
    expect(where([]).sql).toBe("");
  });

  test("eq on text binds the raw value", () => {
    const { sql, params } = where([{ field: "stage", op: "eq", value: "won" }]);
    expect(sql).toBe(`WHERE t0."stage" = $1`);
    expect(params).toEqual(["won"]);
  });

  test("numeric columns bind as text behind a numeric cast", () => {
    const { sql, params } = where([{ field: "id", op: "eq", value: 7 }]);
    expect(sql).toBe(`WHERE t0."id" = $1::numeric`);
    expect(params).toEqual(["7"]);
  });

  test("every comparator token", () => {
    const { sql } = where([
      { field: "amount", op: "neq", value: 1 },
      { field: "amount", op: "gt", value: 2 },
      { field: "amount", op: "gte", value: 3 },
      { field: "amount", op: "lt", value: 4 },
      { field: "amount", op: "lte", value: 5 },
    ]);
    expect(sql).toBe(
      `WHERE t0."amount" != $1::numeric AND t0."amount" > $2::numeric AND ` +
        `t0."amount" >= $3::numeric AND t0."amount" < $4::numeric AND t0."amount" <= $5::numeric`,
    );
  });

  test("in binds one placeholder per member", () => {
    const { sql, params } = where([{ field: "stage", op: "in", values: ["open", "won"] }]);
    expect(sql).toBe(`WHERE t0."stage" IN ($1, $2)`);
    expect(params).toEqual(["open", "won"]);
  });

  test("empty in matches nothing", () => {
    const { sql, params } = where([{ field: "stage", op: "in", values: [] }]);
    expect(sql).toBe("WHERE 1 = 0");
    expect(params).toEqual([]);
  });

  test("nin keeps null rows", () => {
    const { sql, params } = where([{ field: "stage", op: "nin", values: ["lost"] }]);
    expect(sql).toBe(`WHERE (t0."stage" NOT IN ($1) OR t0."stage" IS NULL)`);
    expect(params).toEqual(["lost"]);
  });

  test("empty nin excludes nothing", () => {
    expect(where([{ field: "stage", op: "nin", values: [] }]).sql).toBe("WHERE 1 = 1");
  });

  test("includes escapes LIKE wildcards and the backslash", () => {
    const { sql, params } = where([{ field: "name", op: "includes", value: "50%_off\\x" }]);
    expect(sql).toBe(`WHERE t0."name"::text LIKE $1 ESCAPE '\\'`);
    expect(params).toEqual(["%50\\%\\_off\\\\x%"]);
  });

  test("startswith anchors only the tail", () => {
    const { sql, params } = where([{ field: "name", op: "startswith", value: "Ac" }]);
    expect(sql).toBe(`WHERE t0."name"::text LIKE $1 ESCAPE '\\'`);
    expect(params).toEqual(["Ac%"]);
  });

  test("contains renders array membership on an array column", () => {
    const { sql, params } = where([{ field: "tags", op: "contains", value: "vip" }]);
    expect(sql).toBe(`WHERE $1 = ANY(t0."tags")`);
    expect(params).toEqual(["vip"]);
  });

  test("contains on a non-array column is unsupported", () => {
    expect(statusOf(() => where([{ field: "name", op: "contains", value: "x" }]))).toBe(422);
  });

  test("contains without a flavor arrayContains is unsupported", () => {
    const flavor = { ...postgres() };
    delete flavor.arrayContains;
    const bare: SqlContext = { ...ctx, flavor };
    const binder = new Binder(bare.flavor);
    expect(
      statusOf(() => buildWhere(bare, deals, [{ field: "tags", op: "contains", value: "x" }], undefined, binder)),
    ).toBe(422);
  });

  test("isnull and notnull are nullary", () => {
    const { sql, params } = where([
      { field: "closed_at", op: "isnull" },
      { field: "amount", op: "notnull" },
    ]);
    expect(sql).toBe(`WHERE t0."closed_at" IS NULL AND t0."amount" IS NOT NULL`);
    expect(params).toEqual([]);
  });

  test("an unadvertised operator is refused before rendering", () => {
    const narrow: SqlContext = { ...ctx, operators: new Set(["eq"]) };
    const binder = new Binder(narrow.flavor);
    expect(
      statusOf(() => buildWhere(narrow, deals, [{ field: "name", op: "includes", value: "x" }], undefined, binder)),
    ).toBe(422);
  });

  test("an unknown column is a bad request", () => {
    expect(statusOf(() => where([{ field: "nope", op: "eq", value: 1 }]))).toBe(400);
  });

  test("or-groups render as DNF, one further conjunct", () => {
    const { sql, params } = where(
      [{ field: "stage", op: "eq", value: "open" }],
      [
        [
          { field: "id", op: "eq", value: 1 },
          { field: "amount", op: "isnull" },
        ],
        [{ field: "amount", op: "gt", value: 100 }],
      ],
    );
    expect(sql).toBe(
      `WHERE t0."stage" = $1 AND ((t0."id" = $2::numeric AND t0."amount" IS NULL) OR (t0."amount" > $3::numeric))`,
    );
    expect(params).toEqual(["open", "1", "100"]);
  });
});
