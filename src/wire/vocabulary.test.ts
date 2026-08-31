import { describe, expect, test } from "bun:test";
import { ATLAS_TYPES, AtlasValue, DATE_GRAINS, DateGrain, Filter, JoinField, OPS, UserSort } from "./vocabulary";

describe("vocabulary constants", () => {
  test("OPS is the 15-op list in stable order", () => {
    expect([...OPS]).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "nin",
      "contains",
      "includes",
      "startswith",
      "isnull",
      "notnull",
    ]);
  });

  test("ATLAS_TYPES is the 9-member union in stable order", () => {
    expect([...ATLAS_TYPES]).toEqual([
      "string",
      "number",
      "decimal",
      "boolean",
      "date",
      "datetime",
      "json",
      "array",
      "reference",
    ]);
  });

  test("DATE_GRAINS has no week grain", () => {
    expect([...DATE_GRAINS]).toEqual(["year", "quarter", "month", "day"]);
    expect(DateGrain.safeParse("week").success).toBe(false);
  });
});

describe("AtlasValue", () => {
  test("accepts the four scalar shapes", () => {
    for (const value of ["x", 1, 1.5, true, false, null]) {
      expect(AtlasValue.safeParse(value).success).toBe(true);
    }
  });

  test("rejects non-scalars", () => {
    for (const value of [undefined, {}, [], new Date()]) {
      expect(AtlasValue.safeParse(value).success).toBe(false);
    }
  });
});

describe("Filter", () => {
  test("value ops carry a scalar", () => {
    expect(Filter.safeParse({ field: "name", op: "eq", value: "acme" }).success).toBe(true);
    expect(Filter.safeParse({ field: "name", op: "eq", values: ["acme"] }).success).toBe(false);
    expect(Filter.safeParse({ field: "name", op: "eq" }).success).toBe(false);
  });

  test("member ops carry an array", () => {
    expect(Filter.safeParse({ field: "id", op: "in", values: [1, 2, null] }).success).toBe(true);
    expect(Filter.safeParse({ field: "id", op: "in", value: 1 }).success).toBe(false);
    expect(Filter.safeParse({ field: "id", op: "nin", values: [] }).success).toBe(true);
  });

  test("nullary ops carry neither", () => {
    expect(Filter.safeParse({ field: "x", op: "isnull" }).success).toBe(true);
    expect(Filter.safeParse({ field: "x", op: "notnull" }).success).toBe(true);
    // the strictness law: a payload on a nullary op must reject, never strip
    expect(Filter.safeParse({ field: "x", op: "isnull", values: [1] }).success).toBe(false);
    expect(Filter.safeParse({ field: "x", op: "notnull", value: 1 }).success).toBe(false);
  });

  test("unknown ops and unknown keys reject", () => {
    expect(Filter.safeParse({ field: "x", op: "like", value: "%a%" }).success).toBe(false);
    expect(Filter.safeParse({ field: "x", op: "eq", value: 1, extra: true }).success).toBe(false);
  });
});

describe("UserSort / JoinField strictness", () => {
  test("UserSort rejects unknown dir and unknown keys", () => {
    expect(UserSort.safeParse({ field: "a", dir: "asc" }).success).toBe(true);
    expect(UserSort.safeParse({ field: "a", dir: "up" }).success).toBe(false);
    expect(UserSort.safeParse({ field: "a", dir: "asc", nulls: "last" }).success).toBe(false);
  });

  test("JoinField rejects unknown keys rather than stripping them", () => {
    expect(JoinField.safeParse({ field: "a" }).success).toBe(true);
    expect(JoinField.safeParse({ field: "a", as: "b" }).success).toBe(true);
    expect(JoinField.safeParse({ field: "a", alias: "b" }).success).toBe(false);
  });
});
