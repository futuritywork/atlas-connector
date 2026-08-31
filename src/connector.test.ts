import { describe, expect, test } from "bun:test";
import { AtlasConnector } from "./connector";
import type { AtlasJson } from "./wire/atlas-json";
import type { DiscoveryAnswer } from "./wire/schemas";
import type { SourceRow } from "./wire/vocabulary";

const DOC: AtlasJson = {
  protocolVersion: 1,
  slug: "minimal-test",
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
  endpoints: [],
};

// only the mandatory five; the optional five stay on the base class
class Minimal extends AtlasConnector {
  readonly slug = "minimal-test";
  capability(): AtlasJson {
    return DOC;
  }
  async discovery(): Promise<DiscoveryAnswer> {
    return { tables: [] };
  }
  async query(): Promise<SourceRow[]> {
    return [];
  }
  async *queryStream(): AsyncIterable<SourceRow[]> {}
  async count(): Promise<number> {
    return 0;
  }
  async sampleKeyValues(): Promise<string[]> {
    return [];
  }
}

describe("AtlasConnector base impls", () => {
  const connector = new Minimal();
  const deadline = { timeoutMs: 1000 };

  test("countExact answers null (source only approximates)", async () => {
    expect(await connector.countExact({ table: "t", ...deadline })).toBeNull();
  });

  test("probeColumns answers null", async () => {
    expect(await connector.probeColumns({ table: "t", columns: ["a"], ...deadline })).toBeNull();
  });

  test("probeLink answers null", async () => {
    expect(
      await connector.probeLink({
        fromTable: "a",
        fromColumn: "x",
        toTable: "b",
        toColumn: "y",
        ...deadline,
      }),
    ).toBeNull();
  });

  test("probeGrain answers null", async () => {
    expect(await connector.probeGrain({ table: "t", column: "c", ...deadline })).toBeNull();
  });

  test("aggregate declines with undefined", async () => {
    expect(
      await connector.aggregate({
        table: "t",
        and: [],
        groupBy: [],
        measures: [],
        stringFields: [],
        limit: 10,
        ...deadline,
      }),
    ).toBeUndefined();
  });

  test("optional methods are the base impls until overridden (serve's warning check relies on this)", () => {
    expect(connector.aggregate).toBe(AtlasConnector.prototype.aggregate);
    expect(connector.probeColumns).toBe(AtlasConnector.prototype.probeColumns);
    class WithAggregate extends Minimal {
      override async aggregate(): Promise<SourceRow[] | undefined> {
        return [];
      }
    }
    expect(new WithAggregate().aggregate).not.toBe(AtlasConnector.prototype.aggregate);
  });
});
