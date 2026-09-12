// pins the sdk to the frozen protocol; @futurity/schemas holds the monorepo half of this guard
import { describe, expect, test } from "bun:test";
import { AtlasJson, SourceCapabilitiesWire } from "./atlas-json";
import { ATLAS_TYPES, DATE_GRAINS, Filter, OPS } from "./vocabulary";

const PINNED_OPS = [
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
] as const;

const PINNED_TYPES = [
  "string",
  "number",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "json",
  "array",
  "reference",
] as const;

const PINNED_GRAINS = ["year", "quarter", "month", "day"] as const;

// a changed verdict here is a protocol change, not a test fix
const FILTER_CORPUS: { filter: unknown; ok: boolean }[] = [
  { filter: { field: "a", op: "eq", value: 1 }, ok: true },
  { filter: { field: "a", op: "eq", values: [1] }, ok: false },
  { filter: { field: "a", op: "in", values: [1, null] }, ok: true },
  { filter: { field: "a", op: "in", value: 1 }, ok: false },
  { filter: { field: "a", op: "nin", values: [] }, ok: true },
  { filter: { field: "a", op: "isnull" }, ok: true },
  { filter: { field: "a", op: "isnull", values: [1] }, ok: false },
  { filter: { field: "a", op: "notnull", value: 0 }, ok: false },
  { filter: { field: "a", op: "contains", value: "x" }, ok: true },
  { filter: { field: "a", op: "includes", value: "x" }, ok: true },
  { filter: { field: "a", op: "startswith", value: "x" }, ok: true },
  { filter: { field: "a", op: "like", value: "%x%" }, ok: false },
  { filter: { field: "a", op: "eq", value: 1, extra: true }, ok: false },
  { filter: { field: "a", op: "gt", value: null }, ok: true },
];

describe("wire vocabulary agreement", () => {
  test("OPS matches the frozen protocol list, order included", () => {
    expect([...OPS]).toEqual([...PINNED_OPS]);
  });

  test("ATLAS_TYPES matches the frozen protocol list, order included", () => {
    expect([...ATLAS_TYPES]).toEqual([...PINNED_TYPES]);
  });

  test("DATE_GRAINS matches the frozen protocol list, order included", () => {
    expect([...DATE_GRAINS]).toEqual([...PINNED_GRAINS]);
  });

  test("filter corpus verdicts match the pinned protocol verdicts", () => {
    for (const { filter, ok } of FILTER_CORPUS) {
      expect(Filter.safeParse(filter).success, JSON.stringify(filter)).toBe(ok);
    }
  });

  test("capability doc vocabulary holds: strict flags, slug regex, known endpoints", () => {
    const doc = {
      protocolVersion: 1,
      slug: "my-atlas-connector",
      capabilities: {
        operators: ["eq"],
        dateBucket: false,
        sort: "none",
        offset: false,
        join: false,
        keysEnforced: false,
        limits: { concurrency: 4 },
      },
      credentialSchema: [{ key: "apiKey", label: "API key", type: "password" }],
      endpoints: [],
    };
    const extraFlag = { ...doc.capabilities, extra: true };
    const unknownOperator = { ...doc.capabilities, operators: ["like"] };

    expect(AtlasJson.safeParse(doc).success).toBe(true);
    expect(AtlasJson.safeParse({ ...doc, slug: "X" }).success).toBe(false);
    expect(AtlasJson.safeParse({ ...doc, endpoints: ["probe"] }).success).toBe(false);
    expect(SourceCapabilitiesWire.safeParse(extraFlag).success).toBe(false);
    expect(SourceCapabilitiesWire.safeParse(unknownOperator).success).toBe(false);
  });
});
