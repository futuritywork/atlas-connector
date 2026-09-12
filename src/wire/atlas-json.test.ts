import { describe, expect, test } from "bun:test";
import {
  ATLAS_JSON_MAX_BYTES,
  ATLAS_JSON_PATH,
  AtlasJson,
  ConnectorLimitsWire,
  SourceCapabilitiesWire,
} from "./atlas-json";
import { CONNECTOR_LIMITS } from "./limits";

const capabilities = {
  operators: ["eq", "neq", "isnull", "notnull"],
  dateBucket: false,
  sort: "none",
  offset: false,
  join: false,
  keysEnforced: false,
  limits: { concurrency: 4 },
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
  test("a minimal doc parses, filling in each credential field's required default", () => {
    expect(AtlasJson.parse(doc)).toEqual({
      ...doc,
      credentialSchema: [{ ...doc.credentialSchema[0], required: true }],
    } as AtlasJson);
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

  test("endpoints name the optional protocol methods, and nothing else", () => {
    const every = ["size", "count", "aggregate", "cardinality", "linkHitRate"];
    expect(AtlasJson.safeParse({ ...doc, endpoints: every }).success).toBe(true);
    expect(AtlasJson.safeParse({ ...doc, endpoints: ["dialectQuery"] }).success).toBe(false);
    expect(AtlasJson.safeParse({ ...doc, endpoints: ["probe"] }).success).toBe(false);
  });
});

describe("credentialSchema", () => {
  const field = { key: "apiKey", label: "API key", type: "text" as const };
  const withCredential = (credential: unknown) => ({ ...doc, credentialSchema: [credential] });

  test("is required; a connector with no upstream secret says so with an empty array", () => {
    const { credentialSchema: _dropped, ...credless } = doc;
    expect(AtlasJson.safeParse(credless).success).toBe(false);
    expect(AtlasJson.safeParse({ ...doc, credentialSchema: [] }).success).toBe(true);
  });

  test("a field is key, label, a text, password or textarea type, and nothing else", () => {
    expect(AtlasJson.safeParse(withCredential(field)).success).toBe(true);
    expect(AtlasJson.safeParse(withCredential({ ...field, type: "textarea" })).success).toBe(true);
    expect(AtlasJson.safeParse(withCredential({ ...field, type: "secret" })).success).toBe(false);
    expect(AtlasJson.safeParse(withCredential({ ...field, hint: "x" })).success).toBe(false);
    expect(AtlasJson.safeParse(withCredential({ key: "apiKey", type: "text" })).success).toBe(false);
  });

  test("required defaults to true, so an omitted flag never makes a field optional", () => {
    expect(AtlasJson.parse(withCredential(field)).credentialSchema[0]?.required).toBe(true);
    const optional = AtlasJson.parse(withCredential({ ...field, required: false }));
    expect(optional.credentialSchema[0]?.required).toBe(false);
    expect(AtlasJson.safeParse(withCredential({ ...field, required: "yes" })).success).toBe(false);
  });

  test("placeholder and help are optional strings", () => {
    const help = "Settings -> [API keys](https://x.dev).";
    const described = { ...field, required: true, placeholder: "sk_live_XXXXXXXXXX", help };
    expect(AtlasJson.parse(withCredential(described)).credentialSchema[0]).toEqual(described);
    expect(AtlasJson.safeParse(withCredential({ ...field, help: 7 })).success).toBe(false);
  });
});

describe("SourceCapabilitiesWire", () => {
  test("is strict: an unknown flag rejects", () => {
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, streaming: true }).success).toBe(false);
  });

  test("operators must be known ops", () => {
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, operators: ["like"] }).success).toBe(false);
  });

  test("operators may be empty: a source that pushes nothing says so", () => {
    expect(SourceCapabilitiesWire.safeParse({ ...capabilities, operators: [] }).success).toBe(true);
  });
});

describe("limits", () => {
  test("concurrency is required and stays within 1..16", () => {
    expect(ConnectorLimitsWire.safeParse({}).success).toBe(false);
    expect(ConnectorLimitsWire.safeParse({ concurrency: 0 }).success).toBe(false);
    expect(ConnectorLimitsWire.safeParse({ concurrency: 17 }).success).toBe(false);
    expect(ConnectorLimitsWire.safeParse({ concurrency: 16 }).success).toBe(true);
  });

  test("the vendor ceilings are optional, and never negative", () => {
    const limits = { concurrency: 1, pageSizeMax: 500, rowsPerTableMax: 20_000, offsetMax: 10_000 };
    expect(ConnectorLimitsWire.safeParse(limits).success).toBe(true);
    expect(ConnectorLimitsWire.safeParse({ ...limits, offsetMax: -1 }).success).toBe(false);
    expect(ConnectorLimitsWire.safeParse({ ...limits, pageSizeMax: 0 }).success).toBe(false);
  });
});
