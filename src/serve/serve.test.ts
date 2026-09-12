import { describe, expect, test } from "bun:test";
import { AtlasConnector } from "../connector";
import type { AtlasJson, CapabilityDoc } from "../wire/atlas-json";
import type { DiscoveryAnswer, EntitySize } from "../wire/schemas";
import type { SourceRow } from "../wire/vocabulary";
import { createApp, serve } from "./serve";

const TOKEN = "0123456789abcdef0123456789abcdef";

function doc(overrides: Partial<CapabilityDoc> = {}): CapabilityDoc {
  return {
    protocolVersion: 1,
    slug: "boot-test",
    capabilities: {
      operators: ["eq"],
      dateBucket: false,
      sort: "none",
      offset: false,
      join: false,
      keysEnforced: false,
      limits: { concurrency: 1 },
    },
    credentialSchema: [],
    ...overrides,
  };
}

class BootTestConnector extends AtlasConnector {
  readonly slug = "boot-test";
  constructor(private readonly served: CapabilityDoc = doc()) {
    super();
  }
  capabilities(): CapabilityDoc {
    return this.served;
  }
  async check(): Promise<void> {}
  async discovery(): Promise<DiscoveryAnswer> {
    return { tables: [] };
  }
  async *query(): AsyncIterable<SourceRow[]> {}
}

async function servedDoc(connector: AtlasConnector): Promise<AtlasJson> {
  const app = createApp(connector, { token: TOKEN });
  const response = await app.handle(new Request("http://connector.test/.well-known/futurity/atlas.json"));
  return (await response.json()) as AtlasJson;
}

describe("createApp boot checks", () => {
  test("a token under 32 chars fails boot", () => {
    expect(() => createApp(new BootTestConnector(), { token: "short" })).toThrow("32");
  });

  test("a capability doc that does not parse fails boot", () => {
    const broken = new BootTestConnector(doc({ slug: "NOT A SLUG" }));
    expect(() => createApp(broken, { token: TOKEN })).toThrow("capability document");
  });

  test("endpoints come from the overridden methods, never from the author", async () => {
    class Sized extends BootTestConnector {
      override async size(): Promise<EntitySize> {
        return { rows: 0, exact: true };
      }
    }
    expect((await servedDoc(new BootTestConnector())).endpoints).toEqual([]);
    expect((await servedDoc(new Sized())).endpoints).toEqual(["size"]);
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
