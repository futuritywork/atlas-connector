import { describe, expect, test } from "bun:test";
import { AtlasConnector, windowRows } from "./connector";
import type { CapabilityDoc } from "./wire/atlas-json";
import { CONNECTOR_LIMITS } from "./wire/limits";
import type { DiscoveryAnswer } from "./wire/schemas";
import type { SourceRow } from "./wire/vocabulary";

const DOC: CapabilityDoc = {
  protocolVersion: 1,
  slug: "minimal-test",
  capabilities: {
    operators: ["eq"],
    dateBucket: false,
    sort: "none",
    offset: false,
    join: false,
    keysEnforced: false,
    limits: { concurrency: 1 },
  },
  credentialSchema: [{ key: "apiKey", label: "API key", type: "password", required: true }],
};

class Minimal extends AtlasConnector {
  readonly slug = "minimal-test";
  capabilities(): CapabilityDoc {
    return DOC;
  }
  async check(): Promise<void> {}
  async discovery(): Promise<DiscoveryAnswer> {
    return { tables: [] };
  }
  async *query(): AsyncIterable<SourceRow[]> {
    yield [{ id: 1 }];
  }
}

describe("AtlasConnector optional methods", () => {
  test("a connector that overrides none carries none: the base class ships no stubs", () => {
    const connector = new Minimal();
    expect(connector.size).toBeUndefined();
    expect(connector.count).toBeUndefined();
    expect(connector.aggregate).toBeUndefined();
    expect(connector.cardinality).toBeUndefined();
    expect(connector.linkHitRate).toBeUndefined();
  });
});

describe("windowRows", () => {
  test("windows batches and closes the source on completion or consumer cancellation", async () => {
    for (const cancel of [false, true]) {
      let closed = false;
      async function* source(): AsyncIterable<SourceRow[]> {
        try {
          yield [];
          yield [{ id: -1 }];
          yield Array.from({ length: CONNECTOR_LIMITS.rowsPerBatch + 3 }, (_, id) => ({ id }));
          throw new Error("must not fetch beyond the window");
        } finally {
          closed = true;
        }
      }

      const request = { offset: 2, limit: CONNECTOR_LIMITS.rowsPerBatch + 1 };
      const batches: SourceRow[][] = [];
      for await (const batch of windowRows(source(), request)) {
        batches.push(batch);
        if (cancel) break;
      }

      const full = CONNECTOR_LIMITS.rowsPerBatch;
      expect(closed).toBe(true);
      expect(batches.map((batch) => batch.length)).toEqual(cancel ? [full] : [full, 1]);
      expect(batches[0]?.[0]).toEqual({ id: 1 });
    }
  });
});
