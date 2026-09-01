import { describe, expect, test } from "bun:test";
import { AtlasJson } from "../wire/atlas-json";
import { OPS } from "../wire/vocabulary";
import { sqlCapability } from "./capability";
import { type Column, defineCatalog, type Table } from "./catalog";
import { postgres, type SqlFlavor } from "./flavor";

// the real flavor, with the optional contains spelling stripped unless asked for
const pgFlavor = (opts?: { arrayContains?: boolean }): SqlFlavor => {
  const flavor = postgres();
  if (!opts?.arrayContains) delete flavor.arrayContains;
  return flavor;
};

const column = (name: string, wire: Column["wire"], over?: Partial<Column>): Column => ({
  name,
  wire,
  type: "string",
  nullable: true,
  unique: false,
  description: "",
  ...over,
});

const tableOf = (name: string, columns: Column[]): Table => ({
  name,
  description: "",
  primaryKey: [],
  foreignKeys: [],
  columns,
});

const scalarCatalog = defineCatalog([tableOf("orders", [column("id", "int"), column("status", "text")])]);
const arrayCatalog = defineCatalog([tableOf("orders", [column("id", "int"), column("tags", "text_array")])]);

const capability = (over?: Partial<Parameters<typeof sqlCapability>[0]>) =>
  sqlCapability({
    slug: "test-connector",
    catalog: scalarCatalog,
    flavor: pgFlavor({ arrayContains: true }),
    enforcesDeclaredKeys: false,
    credentialSchema: [{ key: "databaseUrl", label: "Database URL", type: "password" }],
    ...over,
  });

const OPS_SANS_CONTAINS = OPS.filter((op) => op !== "contains");

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
  test("derived doc parses under the wire AtlasJson schema", () => {
    const doc = capability();
    expect(AtlasJson.parse(doc)).toEqual(doc);
  });

  test("serves the native profile: no dialect key", () => {
    expect("dialect" in capability()).toBe(false);
  });

  test("advertises the aggregate endpoint", () => {
    expect(capability().endpoints).toEqual(["aggregate"]);
  });

  test("carries the credential inputs the tenant is asked for", () => {
    expect(capability().credentialSchema).toEqual([
      { key: "databaseUrl", label: "Database URL", type: "password" },
    ]);
  });

  test("threads slug and enforcesDeclaredKeys", () => {
    const doc = capability({ slug: "my-crm", enforcesDeclaredKeys: true });
    expect(doc.slug).toBe("my-crm");
    expect(doc.capabilities.enforcesDeclaredKeys).toBe(true);
  });

  test("derives the fixed sql flags", () => {
    const caps = capability().capabilities;
    expect(caps.dateBucket).toBe(true);
    expect(caps.sort).toBe("multi");
    expect(caps.offset).toBe(true);
    expect(caps.count).toBe("server");
    expect(caps.join).toBe(true);
    expect(caps.probeConcurrency).toBe(4);
    expect(caps.cheapProbes).toBe(false);
  });

  test("overrides win over derived flags", () => {
    const doc = capability({ overrides: { sort: "single", probeConcurrency: 2 } });
    expect(doc.capabilities.sort).toBe("single");
    expect(doc.capabilities.probeConcurrency).toBe(2);
    expect(doc.capabilities.offset).toBe(true);
  });
});
