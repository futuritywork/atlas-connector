import { describe, expect, test } from "bun:test";
import { ATLAS_JSON_MAX_BYTES, ATLAS_JSON_PATH, AtlasJson, SourceCapabilitiesWire } from "./atlas-json";
import { CONNECTOR_LIMITS } from "./limits";

const capabilities = {
  operators: ["eq", "neq", "isnull", "notnull"],
  dateBucket: false,
  sort: "none",
  offset: false,
  count: "server",
  join: false,
  enforcesDeclaredKeys: false,
  probeConcurrency: 4,
  cheapProbes: false,
};

const doc = {
  protocolVersion: 1,
  slug: "my-atlas-connector",
  capabilities,
  credentialSchema: [{ key: "databaseUrl", label: "Database URL", type: "password" }],
  endpoints: [],
};

test("the doc path and byte cap come from the wire limits", () => {
  expect(ATLAS_JSON_PATH).toBe("/.well-known/futurity/atlas.json");
  expect(ATLAS_JSON_MAX_BYTES).toBe(CONNECTOR_LIMITS.docBytes);
});

describe("AtlasJson", () => {
  test("a minimal doc parses", () => {
    expect(AtlasJson.parse(doc)).toEqual(doc as AtlasJson);
  });

  test("unknown top-level fields strip for forward compat", () => {
    const parsed = AtlasJson.parse({ ...doc, futureField: true });
    expect("futureField" in parsed).toBe(false);
  });

  test("dialect is an open string here; the consumer narrows it", () => {
    expect(AtlasJson.safeParse({ ...doc, dialect: "postgres" }).success).toBe(true);
    expect(AtlasJson.safeParse({ ...doc, dialect: "some-future-dialect" }).success).toBe(true);
    expect(AtlasJson.safeParse({ ...doc, dialect: 7 }).success).toBe(false);
  });

  test("slug shape holds: lowercase start, 3-40 chars", () => {
    expect(AtlasJson.safeParse({ ...doc, slug: "abc" }).success).toBe(true);
    expect(AtlasJson.safeParse({ ...doc, slug: "a".repeat(40) }).success).toBe(true);
    expect(AtlasJson.safeParse({ ...doc, slug: "ab" }).success).toBe(false);
    expect(AtlasJson.safeParse({ ...doc, slug: "a".repeat(41) }).success).toBe(false);
    expect(AtlasJson.safeParse({ ...doc, slug: "My-Connector" }).success).toBe(false);
    expect(AtlasJson.safeParse({ ...doc, slug: "1connector" }).success).toBe(false);
  });

  test("only protocol version 1 exists", () => {
    expect(AtlasJson.safeParse({ ...doc, protocolVersion: 2 }).success).toBe(false);
  });

  test("aggregate is the only optional endpoint", () => {
    expect(AtlasJson.safeParse({ ...doc, endpoints: ["aggregate"] }).success).toBe(true);
    expect(AtlasJson.safeParse({ ...doc, endpoints: ["dialectQuery"] }).success).toBe(false);
  });
});

describe("credentialSchema", () => {
  test("is required; a connector with no upstream secret says so with an empty array", () => {
    const { credentialSchema: _dropped, ...credless } = doc;
    expect(AtlasJson.safeParse(credless).success).toBe(false);
    expect(AtlasJson.safeParse({ ...doc, credentialSchema: [] }).success).toBe(true);
  });

  test("a field is exactly key, label, and a text or password type", () => {
    const field = { key: "apiKey", label: "API key", type: "text" };
    expect(AtlasJson.safeParse({ ...doc, credentialSchema: [field] }).success).toBe(true);
    expect(AtlasJson.safeParse({ ...doc, credentialSchema: [{ ...field, type: "secret" }] }).success).toBe(
      false,
    );
    expect(AtlasJson.safeParse({ ...doc, credentialSchema: [{ ...field, hint: "x" }] }).success).toBe(false);
    expect(AtlasJson.safeParse({ ...doc, credentialSchema: [{ key: "apiKey", type: "text" }] }).success).toBe(
      false,
    );
  });
});

describe("SourceCapabilitiesWire", () => {
  test("is strict: an unknown flag rejects", () => {
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, streaming: true }).success).toBe(false);
  });

  test("operators must be known and non-empty", () => {
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, operators: [] }).success).toBe(false);
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, operators: ["like"] }).success).toBe(false);
  });

  test("probeConcurrency stays within 1..8", () => {
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, probeConcurrency: 0 }).success).toBe(false);
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, probeConcurrency: 9 }).success).toBe(false);
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, probeConcurrency: 8 }).success).toBe(true);
  });

  test("maxOffset is optional but never negative", () => {
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, maxOffset: 10_000 }).success).toBe(true);
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, maxOffset: -1 }).success).toBe(false);
  });
});
