import { afterEach, describe, expect, spyOn, test } from "bun:test";
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

class WithAggregate extends BootTestConnector {
  override async aggregate(): Promise<SourceRow[] | undefined> {
    return [];
  }
}

const spies: { mockRestore(): void }[] = [];
function silence() {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  spies.push(warn, log);
  return { warn, log };
}
afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

describe("createApp boot checks", () => {
  test("a token under 32 chars fails boot", () => {
    expect(() => createApp(new BootTestConnector(), { token: "short" })).toThrow("32");
  });

  test("a capability doc that does not parse fails boot", () => {
    const broken = new BootTestConnector(doc({ slug: "NOT A SLUG" }));
    silence();
    expect(() => createApp(broken, { token: TOKEN })).toThrow("capability document");
  });

  test("advertised aggregate over the base decline warns", () => {
    const { warn } = silence();
    createApp(new BootTestConnector(doc({ endpoints: ["aggregate"] })), { token: TOKEN });
    const warned = warn.mock.calls.map((call) => String(call[0]));
    expect(warned.some((message) => message.includes("base decline"))).toBe(true);
  });

  test("implemented aggregate without the endpoint advertisement warns", () => {
    const { warn } = silence();
    createApp(new WithAggregate(doc()), { token: TOKEN });
    const warned = warn.mock.calls.map((call) => String(call[0]));
    expect(warned.some((message) => message.includes('omits "aggregate"'))).toBe(true);
  });

  test("a consistent connector boots without aggregate warnings", () => {
    const { warn } = silence();
    createApp(new WithAggregate(doc({ endpoints: ["aggregate"] })), { token: TOKEN });
    expect(warn.mock.calls.length).toBe(0);
  });

  test("derived profiling gets one boot log line naming every un-overridden method", () => {
    const { log } = silence();
    createApp(new BootTestConnector(), { token: TOKEN });
    const logged = log.mock.calls.map((call) => String(call[0]));
    expect(
      logged.filter((message) =>
        message.includes(
          "profileColumns, profileLink, profileGrain, exactCount, sampleColumnValues scan through query()",
        ),
      ).length,
    ).toBe(1);
  });
});

describe("serve", () => {
  test("listens, serves the well-known, and stops", async () => {
    silence();
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
