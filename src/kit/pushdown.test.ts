import { describe, expect, test } from "bun:test";
import { AtlasJson } from "../wire/atlas-json";
import { defineCapability, type Pushdown, pushdownCapabilities, pushedOps } from "./pushdown";

const SOURCE_WIDE: Pushdown = { ops: ["eq", "in"], sort: "single", offset: true };

const PER_ENTITY: Pushdown = {
  ops: ["eq"],
  entities: {
    goods_receipts: { ops: ["eq", "gte", "lte"], fields: { branchID: ["eq", "in"] } },
    branches: {},
  },
};

describe("pushedOps", () => {
  test("an entity with no entry of its own falls back to the source-wide set", () => {
    expect([...pushedOps(PER_ENTITY, "suppliers")]).toEqual(["eq"]);
    expect([...pushedOps(PER_ENTITY, "branches")]).toEqual(["eq"]);
  });

  test("an entity's own set replaces the source-wide one", () => {
    expect([...pushedOps(PER_ENTITY, "goods_receipts")]).toEqual(["eq", "gte", "lte"]);
  });

  test("a field's set replaces the entity's", () => {
    expect([...pushedOps(PER_ENTITY, "goods_receipts", "branchID")]).toEqual(["eq", "in"]);
    expect([...pushedOps(PER_ENTITY, "goods_receipts", "total")]).toEqual(["eq", "gte", "lte"]);
  });

  test("a map that declares nothing pushes nothing", () => {
    expect([...pushedOps({}, "anything")]).toEqual([]);
  });
});

describe("pushdownCapabilities", () => {
  test("operators are every op the map can push anywhere", () => {
    expect(pushdownCapabilities(PER_ENTITY).operators.sort()).toEqual(["eq", "gte", "in", "lte"]);
  });

  test("sort, offset and join default to no", () => {
    expect(pushdownCapabilities({})).toEqual({ operators: [], sort: "none", offset: false, join: false });
  });

  test("what the map declares is what the doc advertises", () => {
    expect(pushdownCapabilities(SOURCE_WIDE)).toEqual({
      operators: ["eq", "in"],
      sort: "single",
      offset: true,
      join: false,
    });
  });
});

describe("defineCapability", () => {
  const doc = defineCapability({
    slug: "vendor-x",
    pushdown: SOURCE_WIDE,
    limits: { pageSizeMax: 500, rowsPerTableMax: 20_000, concurrency: 1 },
    keysEnforced: false,
    dateBucket: false,
    credentialSchema: [{ key: "apiKey", label: "API key", type: "password", required: true }],
  });

  test("the doc parses once serve() has filled endpoints", () => {
    expect(AtlasJson.parse({ ...doc, endpoints: [] })).toEqual({ ...doc, endpoints: [] });
  });

  test("the map owns the query half and the vendor block owns the rest", () => {
    expect(doc.capabilities).toEqual({
      operators: ["eq", "in"],
      sort: "single",
      offset: true,
      join: false,
      dateBucket: false,
      keysEnforced: false,
      limits: { pageSizeMax: 500, rowsPerTableMax: 20_000, concurrency: 1 },
    });
  });

  test("dialect is absent rather than undefined, so the doc serializes without the key", () => {
    const vendor = {
      slug: "vendor-x",
      pushdown: {},
      limits: { concurrency: 1 },
      keysEnforced: false,
      dateBucket: false,
      credentialSchema: [],
    };
    expect("dialect" in defineCapability(vendor)).toBe(false);
    expect(defineCapability({ ...vendor, dialect: "postgres" }).dialect).toBe("postgres");
  });
});
