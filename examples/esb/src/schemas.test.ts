import { describe, expect, test } from "bun:test";
import type { EsbCoreObject } from "./types";
import {
  createFilterSetSchema,
  createRowSchema,
  EsbDateValue,
  EsbDatetimeValue,
  parseEsbConfig,
} from "./schemas";

const FIELD_TYPES = {
  happenedAt: "datetime",
  businessDate: "date",
  amount: "decimal",
  enabled: "boolean",
  label: "string",
} as const;

const TYPED_OBJECT: EsbCoreObject = {
  name: "typed",
  path: "/typed",
  description: "Typed fixture",
  mode: "paged",
  primaryKey: "id",
  columns: [
    { name: "id", type: "string", nullable: false, description: "ID" },
    { name: "businessDate", type: "date", nullable: true, description: "Business Date" },
    { name: "happenedAt", type: "datetime", nullable: true, description: "Happened At" },
    { name: "amount", type: "decimal", nullable: true, description: "Amount" },
    { name: "enabled", type: "boolean", nullable: true, description: "Enabled" },
  ],
};

describe("ESB value schemas", () => {
  test("canonicalizes zoned datetimes and preserves valid zone-less datetimes", () => {
    expect(EsbDatetimeValue.parse("2024-01-01T09:00:00+07:00")).toBe("2024-01-01T02:00:00.000Z");
    expect(EsbDatetimeValue.parse("2024-01-01T02:00:00Z")).toBe("2024-01-01T02:00:00.000Z");
    expect(EsbDatetimeValue.parse("2024-01-01T09:00:00")).toBe("2024-01-01T09:00:00");
    expect(EsbDatetimeValue.parse(null)).toBeNull();
  });

  test("rejects invalid datetime values instead of falling back to Atlas scalars", () => {
    for (const value of [
      "2024-01-01",
      "2024-02-30T00:00:00Z",
      "2024-01-01T24:00:00Z",
      "2024-01-01T00:00:00+24:00",
      1_704_067_200_000,
      true,
    ]) {
      expect(EsbDatetimeValue.safeParse(value).success).toBe(false);
    }
  });

  test("accepts only canonical date text or null", () => {
    expect(EsbDateValue.parse("2024-01-01")).toBe("2024-01-01");
    expect(EsbDateValue.parse(null)).toBeNull();
    expect(EsbDateValue.safeParse("2024-02-30").success).toBe(false);
    expect(EsbDateValue.safeParse("2024-01-01T00:00:00Z").success).toBe(false);
  });

  test("builds catalog-derived row schemas that normalize and enforce field types", () => {
    expect(
      createRowSchema(TYPED_OBJECT).parse({
        id: "one",
        businessDate: "2024-01-01",
        happenedAt: "2024-01-01T09:00:00+07:00",
        amount: "10.50",
        enabled: 1,
        futureField: { nested: true },
      }),
    ).toEqual({
      id: "one",
      businessDate: "2024-01-01",
      happenedAt: "2024-01-01T02:00:00.000Z",
      amount: "10.50",
      enabled: true,
    });
    expect(createRowSchema(TYPED_OBJECT).parse({ id: "one" })).toEqual({ id: "one" });

    for (const row of [
      { id: null },
      { id: "one", businessDate: "2024-02-30" },
      { id: "one", happenedAt: "not-a-datetime" },
      { id: "one", amount: "1e-7" },
      { id: "one", amount: Number.MAX_SAFE_INTEGER + 1 },
      { id: "one", enabled: 2 },
    ]) {
      expect(createRowSchema(TYPED_OBJECT).safeParse(row).success).toBe(false);
    }
  });
});

describe("ESB filter schemas", () => {
  test("normalizes typed scalar and set operands without mutating the request", () => {
    const filters = {
      and: [
        { field: "happenedAt", op: "eq", value: "2024-01-01T02:00:00Z" },
        { field: "businessDate", op: "eq", value: "2024-01-01" },
        { field: "amount", op: "gte", value: "10.50" },
        { field: "label", op: "isnull" },
      ],
      or: [
        [{ field: "happenedAt", op: "in", values: ["2024-01-01T09:00:00+07:00", null] }],
        [{ field: "label", op: "startswith", value: "2024" }],
      ],
    };

    expect(createFilterSetSchema(FIELD_TYPES).parse(filters)).toEqual({
      and: [
        { field: "happenedAt", op: "eq", value: "2024-01-01T02:00:00.000Z" },
        { field: "businessDate", op: "eq", value: "2024-01-01" },
        { field: "amount", op: "gte", value: "10.50" },
        { field: "label", op: "isnull" },
      ],
      or: [
        [{ field: "happenedAt", op: "in", values: ["2024-01-01T02:00:00.000Z", null] }],
        [{ field: "label", op: "startswith", value: "2024" }],
      ],
    });
    expect(filters.and[0]?.value).toBe("2024-01-01T02:00:00Z");
  });

  test("rejects operands that contradict catalog types", () => {
    const schema = createFilterSetSchema(FIELD_TYPES);
    for (const filter of [
      { field: "happenedAt", op: "eq", value: "not-a-datetime" },
      { field: "businessDate", op: "in", values: ["2024-02-30"] },
      { field: "amount", op: "eq", value: 1e-7 },
      { field: "amount", op: "eq", value: Number.MAX_SAFE_INTEGER + 1 },
      { field: "enabled", op: "eq", value: 1 },
      { field: "label", op: "eq", value: true },
    ]) {
      expect(schema.safeParse({ and: [filter] }).success).toBe(false);
    }
  });

  test("retains textual and strict Atlas filter behavior", () => {
    const schema = createFilterSetSchema(FIELD_TYPES);
    expect(
      schema.parse({ and: [{ field: "businessDate", op: "startswith", value: "2024" }] }),
    ).toEqual({ and: [{ field: "businessDate", op: "startswith", value: "2024" }] });
    expect(
      schema.safeParse({
        and: [{ field: "happenedAt", op: "eq", value: "2024-01-01T02:00:00Z", extra: true }],
      }).success,
    ).toBe(false);
  });
});

describe("ESB configuration schema", () => {
  const token = "x".repeat(32);

  test("uses the default port and honors PORT precedence", () => {
    expect(parseEsbConfig({ ATLAS_CONNECTOR_TOKEN: token })).toEqual({ port: 4100, bearerToken: token });
    expect(
      parseEsbConfig({ PORT: "4200", CONNECTOR_PORT: "4300", ATLAS_CONNECTOR_TOKEN: token }),
    ).toEqual({ port: 4200, bearerToken: token });
  });

  test("rejects invalid ports and bearer tokens", () => {
    for (const port of ["", "0", "65536", "1.5", "abc", "Infinity"]) {
      expect(() => parseEsbConfig({ PORT: port, ATLAS_CONNECTOR_TOKEN: token })).toThrow(/port/i);
    }
    expect(() => parseEsbConfig({})).toThrow(/ATLAS_CONNECTOR_TOKEN/);
    expect(() => parseEsbConfig({ ATLAS_CONNECTOR_TOKEN: "short" })).toThrow(/ATLAS_CONNECTOR_TOKEN/);
  });
});
