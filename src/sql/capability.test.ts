import { describe, expect, test } from "bun:test";
import { AtlasJson } from "../wire/atlas-json";
import { OPS } from "../wire/vocabulary";
import { sqlCapability } from "./capability";
import { col, type Column, defineCatalog, type Table } from "./catalog";
import { postgres, type SqlFlavor } from "./flavor";

const OPS_SANS_CONTAINS = OPS.filter((op) => op !== "contains");

// the real flavor, with the optional contains spelling stripped unless asked for
const pgFlavor = (opts?: { arrayContains?: boolean }): SqlFlavor => {
  const flavor = postgres();
  if (!opts?.arrayContains) delete flavor.arrayContains;
  return flavor;
};

const tableOf = (name: string, columns: Column[]): Table => ({
  name,
  description: "",
  primaryKey: [],
  foreignKeys: [],
  columns,
});

const scalarCatalog = defineCatalog([
  tableOf("orders", [col("id", "int", "number"), col("status", "text", "string")]),
]);

const arrayCatalog = defineCatalog([
  tableOf("orders", [col("id", "int", "number"), col("tags", "text_array", "array")]),
]);

const capability = (over?: Partial<Parameters<typeof sqlCapability>[0]>) =>
  sqlCapability({
    slug: "test-connector",
    catalog: scalarCatalog,
    flavor: pgFlavor({ arrayContains: true }),
    keysEnforced: false,
    credentialSchema: [{ key: "databaseUrl", label: "Database URL", type: "password", required: true }],
    ...over,
  });

describe("sqlCapability operator derivation", () => {
  test("drops contains when no column is a text_array", () => {
    expect(capability().capabilities.operators).toEqual(OPS_SANS_CONTAINS);
  });

  test("drops contains when the flavor cannot spell array membership", () => {
    const doc = capability({ catalog: arrayCatalog, flavor: pgFlavor() });
    expect(doc.capabilities.operators).toEqual(OPS_SANS_CONTAINS);
  });

  test("advertises contains only with both a text_array column and a flavor spelling", () => {
    const doc = capability({ catalog: arrayCatalog });
    expect(doc.capabilities.operators).toEqual([...OPS]);
  });
});

describe("sqlCapability doc shape", () => {
  test("derived doc parses under the wire AtlasJson schema once serve() fills endpoints", () => {
    const doc = { ...capability(), endpoints: [] };
    expect(AtlasJson.parse(doc)).toEqual(doc);
  });

  test("serves the native profile: no dialect key", () => {
    expect("dialect" in capability()).toBe(false);
  });

  test("carries the credential inputs the tenant is asked for", () => {
    expect(capability().credentialSchema).toEqual([
      { key: "databaseUrl", label: "Database URL", type: "password", required: true },
    ]);
  });

  test("threads slug and keysEnforced", () => {
    const doc = capability({ slug: "my-crm", keysEnforced: true });
    expect(doc.slug).toBe("my-crm");
    expect(doc.capabilities.keysEnforced).toBe(true);
  });

  test("derives the fixed sql flags", () => {
    const caps = capability().capabilities;
    expect(caps.dateBucket).toBe(true);
    expect(caps.sort).toBe("multi");
    expect(caps.offset).toBe(true);
    expect(caps.join).toBe(true);
    expect(caps.limits).toEqual({ concurrency: 4 });
  });

  test("a driver's own ceilings fold into the limits block", () => {
    const doc = capability({ limits: { pageSizeMax: 1000, concurrency: 1 } });
    expect(doc.capabilities.limits).toEqual({ pageSizeMax: 1000, concurrency: 1 });
  });
});
