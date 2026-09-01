// the SDK half of the wire-agreement guard. the monorepo carries its own copy of this vocabulary
// (@futurity/schemas) plus a wire-agreement test against the installed SDK; this file pins the
// SDK side to the frozen protocol so a drift-inducing edit fails CI even with no monorepo present.
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

// verdicts must match the monorepo Filter's on the same corpus; a change to either side of a
// case here is a protocol change, not a refactor
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

  test("capability doc vocabulary holds: strict flags, slug regex, aggregate-only endpoints", () => {
    const doc = {
      protocolVersion: 1,
      slug: "my-atlas-connector",
      capabilities: {
        operators: ["eq"],
        dateBucket: false,
        sort: "none",
        offset: false,
        count: "server",
        join: false,
        enforcesDeclaredKeys: false,
        probeConcurrency: 4,
        cheapProbes: false,
      },
      credentialSchema: [{ key: "apiKey", label: "API key", type: "password" }],
      endpoints: [],
    };
    expect(AtlasJson.safeParse(doc).success).toBe(true);
    expect(AtlasJson.safeParse({ ...doc, slug: "X" }).success).toBe(false);
    expect(AtlasJson.safeParse({ ...doc, endpoints: ["probe"] }).success).toBe(false);
    expect(
      SourceCapabilitiesWire.safeParse({ ...doc.capabilities, extra: true }).success,
    ).toBe(false);
    expect(
      SourceCapabilitiesWire.safeParse({
        ...doc.capabilities,
        operators: ["like"],
      }).success,
    ).toBe(false);
  });
});
