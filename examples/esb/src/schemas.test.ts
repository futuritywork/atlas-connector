import { describe, expect, test } from "bun:test";
import { field } from "@futurity/atlas-connector";
import { ESB_CORE_CATALOG } from "./catalog";
import type { EsbCoreObject } from "./types";
import { EsbRow, parseEsbConfig } from "./schemas";

const TYPED_OBJECT: EsbCoreObject = {
  name: "typed",
  path: "/typed",
  description: "Typed fixture",
  mode: "paged",
  primaryKey: "id",
  columns: [
    field("id", "string", { unique: true, description: "ID" }),
    field("businessDate", "date", { nullable: true, description: "Business Date" }),
    field("happenedAt", "datetime", { nullable: true, description: "Happened At" }),
    field("amount", "decimal", { nullable: true, description: "Amount" }),
    field("enabled", "boolean", { nullable: true, description: "Enabled" }),
  ],
};

const GOODS_DELIVERIES = ESB_CORE_CATALOG.find((object) => object.name === "goods_deliveries")!;

describe("ESB value schemas", () => {
  const happenedAt = EsbRow(TYPED_OBJECT, ["happenedAt"]);

  test("canonicalizes zoned datetimes and preserves valid zone-less datetimes", () => {
    expect(happenedAt.parse({ happenedAt: "2024-01-01T09:00:00+07:00" })).toEqual({
      happenedAt: "2024-01-01T02:00:00.000Z",
    });
    expect(happenedAt.parse({ happenedAt: "2024-01-01T02:00:00Z" })).toEqual({
      happenedAt: "2024-01-01T02:00:00.000Z",
    });
    expect(happenedAt.parse({ happenedAt: "2024-01-01T09:00:00" })).toEqual({
      happenedAt: "2024-01-01T09:00:00",
    });
    expect(happenedAt.parse({ happenedAt: null })).toEqual({ happenedAt: null });
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
      expect(happenedAt.safeParse({ happenedAt: value }).success).toBe(false);
    }
  });

  test("builds catalog-derived row schemas that normalize and enforce field types", () => {
    expect(
      EsbRow(TYPED_OBJECT).parse({
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
    expect(EsbRow(TYPED_OBJECT).parse({ id: "one" })).toEqual({ id: "one" });

    for (const row of [
      { id: null },
      { id: "one", businessDate: "2024-02-30" },
      { id: "one", happenedAt: "not-a-datetime" },
      { id: "one", amount: "1e-7" },
      { id: "one", amount: Number.MAX_SAFE_INTEGER + 1 },
      { id: "one", enabled: 2 },
    ]) {
      expect(EsbRow(TYPED_OBJECT).safeParse(row).success).toBe(false);
    }
  });

  test("requires all-nullable rows to contain a selected catalog field", () => {
    const schema = EsbRow(GOODS_DELIVERIES);
    for (const row of [{ unexpected: { junk: true } }, {}]) {
      const parsed = schema.safeParse(row);
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("goods_deliveries");
    }

    expect(schema.parse({ goodsDeliveryNum: null })).toEqual({ goodsDeliveryNum: null });
    expect(EsbRow(GOODS_DELIVERIES, ["goodsDeliveryNum"]).safeParse({ statusName: "Complete" }).success).toBe(false);
    expect(EsbRow(GOODS_DELIVERIES, ["goodsDeliveryNum"]).parse({ goodsDeliveryNum: null })).toEqual({
      goodsDeliveryNum: null,
    });
  });

  test("an empty projection has no catalog field to require, so count() rows still parse", () => {
    expect(EsbRow(GOODS_DELIVERIES, []).parse({ goodsDeliveryNum: "GD1" })).toEqual({});
    expect(EsbRow(GOODS_DELIVERIES, []).parse({})).toEqual({});
  });

  test("normalizes every flagActive field from numeric and boolean inputs", () => {
    const objects = ESB_CORE_CATALOG.filter((object) => object.columns.some((column) => column.name === "flagActive"));
    expect(objects.map((object) => object.name)).toEqual([
      "purposes",
      "bills_of_material",
      "categories",
      "cost_centers",
      "customers",
      "document_templates",
      "products",
      "subcategories",
      "supplier_categories",
      "suppliers",
    ]);

    for (const object of objects) {
      const schema = EsbRow(object, ["flagActive"]);
      for (const value of [1, true]) {
        const parsed = schema.safeParse({ flagActive: value });
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.flagActive).toBe(true);
      }
    }
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
