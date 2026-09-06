import { describe, expect, test } from "bun:test";
import {
  ATLAS_TYPES,
  AtlasBoolean,
  AtlasDate,
  AtlasDatetime,
  AtlasNumeric,
  AtlasValue,
  DATE_GRAINS,
  DateGrain,
  Filter,
  JoinField,
  OPS,
  UserSort,
} from "./vocabulary";

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

describe("typed Atlas values", () => {
  test("numeric values preserve plain digit-exact strings and safe numbers", () => {
    for (const value of ["10.50", "9007199254740993", -12, 1.5]) {
      expect(AtlasNumeric.parse(value)).toBe(value);
    }
    for (const value of ["1e3", "not-a-number", 1e-7, 1e21, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(AtlasNumeric.safeParse(value).success).toBe(false);
    }
  });

  test("boolean values are strict JSON booleans", () => {
    expect(AtlasBoolean.parse(true)).toBe(true);
    expect(AtlasBoolean.parse(false)).toBe(false);
    expect(AtlasBoolean.safeParse(1).success).toBe(false);
    expect(AtlasBoolean.safeParse("true").success).toBe(false);
  });

  test("date values are canonical calendar dates", () => {
    expect(AtlasDate.parse("2024-02-29")).toBe("2024-02-29");
    expect(AtlasDate.safeParse("2024-02-30").success).toBe(false);
    expect(AtlasDate.safeParse("2024-01-01T00:00:00Z").success).toBe(false);
  });

  test("datetime values accept UTC Z and zone-less ISO forms, but not offsets", () => {
    expect(AtlasDatetime.parse("2024-01-01T00:00:00Z")).toBe("2024-01-01T00:00:00Z");
    expect(AtlasDatetime.parse("2024-01-01T00:00:00")).toBe("2024-01-01T00:00:00");
    expect(AtlasDatetime.safeParse("2024-01-01T07:00:00+07:00").success).toBe(false);
    expect(AtlasDatetime.safeParse("2024-02-30T00:00:00Z").success).toBe(false);
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
