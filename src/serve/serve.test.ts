import { describe, expect, test } from "bun:test";
import { AtlasConnector } from "../connector";
import type { AtlasJson } from "../wire/atlas-json";
import type { DiscoveryAnswer } from "../wire/schemas";
import type { SourceRow } from "../wire/vocabulary";
import { createApp, serve } from "./serve";

const TOKEN = "0123456789abcdef0123456789abcdef";

function doc(overrides: Partial<AtlasJson> = {}): AtlasJson {
  return {
    protocolVersion: 1,
    slug: "boot-test",
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
    credentialSchema: [],
    endpoints: [],
    ...overrides,
  };
}

class BootTestConnector extends AtlasConnector {
  readonly slug = "boot-test";
  constructor(private readonly served: AtlasJson = doc()) {
    super();
  }
  capability(): AtlasJson {
    return this.served;
  }
  async check(): Promise<void> {}
  async discover(): Promise<DiscoveryAnswer> {
    return { tables: [] };
  }
  async *query(): AsyncIterable<SourceRow[]> {}
  async count(): Promise<number> {
    return 0;
  }
}

describe("createApp boot checks", () => {
  test("a token under 32 chars fails boot", () => {
    expect(() => createApp(new BootTestConnector(), { token: "short" })).toThrow("32");
  });

  test("a capability doc that does not parse fails boot", () => {
    const broken = new BootTestConnector(doc({ slug: "NOT A SLUG" }));
    expect(() => createApp(broken, { token: TOKEN })).toThrow("capability document");
  });
});

describe("serve", () => {
  test("listens, serves the well-known, and stops", async () => {
    const running = serve(new BootTestConnector(), { token: TOKEN, port: 0 });
    try {
      expect(running.url).toMatch(/^http:\/\//);
      const response = await fetch(`${running.url}/.well-known/futurity/atlas.json`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as AtlasJson;
      expect(body.slug).toBe("boot-test");
    } finally {
      await running.stop();
    }
  });
});
