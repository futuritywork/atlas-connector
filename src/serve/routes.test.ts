import { describe, expect, spyOn, test } from "bun:test";
import { AtlasConnector } from "../connector";
import type { CapabilityDoc } from "../wire/atlas-json";
import type {
  AggregateRequest,
  CheckRequest,
  DiscoveryAnswer,
  EntitySize,
  LinkHitRate,
  NativeQueryRequest,
  TableCardinality,
} from "../wire/schemas";
import type { SourceRow } from "../wire/vocabulary";
import { badRequest, unknownEntity } from "./errors";
import { createApp } from "./serve";

const TOKEN = "0123456789abcdef0123456789abcdef";
const JSON_ONLY = { "content-type": "application/json" };
const AUTH = { ...JSON_ONLY, authorization: `Bearer ${TOKEN}` };
const WRONG_BEARER = { ...JSON_ONLY, authorization: `Bearer ${"x".repeat(32)}` };
const CREDS = { apiKey: "right-key" };

const DOC: CapabilityDoc = {
  protocolVersion: 1,
  slug: "route-test",
  capabilities: {
    operators: ["eq"],
    dateBucket: false,
    sort: "none",
    offset: false,
    join: false,
    keysEnforced: false,
    limits: { pageSizeMax: 100, concurrency: 2 },
  },
  credentialSchema: [{ key: "apiKey", label: "API key", type: "password", required: true }],
};

const QUERY = {
  table: "t",
  and: [],
  sort: [],
  fields: ["a"],
  credentials: CREDS,
  timeoutMs: 1000,
  idleTimeoutMs: 1000,
  maxTimeoutMs: 5000,
};

// only the four abstract methods; the optional routes must not exist on this app
class BareConnector extends AtlasConnector {
  readonly slug = "route-test";
  capabilities(): CapabilityDoc {
    return DOC;
  }
  async check(req: CheckRequest): Promise<void> {
    if (req.credentials.apiKey === "malformed") throw badRequest("missing credentials: appToken");
    if (req.credentials.apiKey === "slow") await new Promise(() => {});
    if (req.credentials.apiKey !== CREDS.apiKey) throw new Error("lark rejected the app secret");
  }
  async discovery(): Promise<DiscoveryAnswer> {
    return { tables: [], warnings: ["w1"] };
  }
  async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    if (req.table === "missing") throw unknownEntity(`unknown table ${req.table}`);
    if (req.table === "explodes") throw new Error("password=hunter2 leaked stack");
    if (req.table === "slow") await new Promise(() => {});
    yield [{ a: 1 }];
    yield [{ a: 2 }];
  }
}

class RouteTestConnector extends BareConnector {
  override async size(req: { table: string }): Promise<EntitySize | null> {
    return req.table === "unsized" ? null : { rows: 10, exact: true };
  }
  override async count(): Promise<number> {
    return 7;
  }
  override async cardinality(req: { table: string }): Promise<TableCardinality> {
    if (req.table === "missing") throw unknownEntity(`unknown table ${req.table}`);
    return { a: { nonNull: 2, distinct: 2 }, b: null };
  }
  override async linkHitRate(): Promise<LinkHitRate> {
    return { fromNonNull: 4, orphanCount: 1, orphanRate: 0.25, orphanSamples: ["ghost"] };
  }
  override async aggregate(req: AggregateRequest): Promise<SourceRow[] | undefined> {
    if (req.table === "declined") return undefined;
    return [{ g: "x", n: 3 }];
  }
}

// right shape, wrong identity: a ConnectorError minted by a second copy of the sdk
class ForeignErrorConnector extends RouteTestConnector {
  override async *query(): AsyncIterable<SourceRow[]> {
    throw Object.assign(new Error("unknown table 'ghost'"), { name: "ConnectorError", status: 404 });
  }
}

type Handler = { handle(request: Request): Promise<Response> };

const app = createApp(new RouteTestConnector(), { token: TOKEN });

function postTo(
  target: Handler,
  path: string,
  body: unknown,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return target.handle(
    new Request(`http://connector.test${path}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return postTo(app, path, body, headers);
}

function wellKnown(target: Handler): Promise<Response> {
  return target.handle(new Request("http://connector.test/.well-known/futurity/atlas.json"));
}

async function lines(response: Response): Promise<unknown[]> {
  return (await response.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

describe("well-known", () => {
  test("serves the capability doc without auth, endpoints filled from the overrides", async () => {
    const response = await wellKnown(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...DOC,
      endpoints: ["size", "count", "aggregate", "cardinality", "linkHitRate"],
    });
  });

  test("a connector that overrides nothing declares no endpoints", async () => {
    const response = await wellKnown(createApp(new BareConnector(), { token: TOKEN }));
    expect(((await response.json()) as { endpoints: string[] }).endpoints).toEqual([]);
  });
});

describe("auth", () => {
  test("a data endpoint without a bearer answers the 401 envelope", async () => {
    const response = await post("/query", QUERY, JSON_ONLY);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "missing bearer token" },
    });
  });

  test("a wrong bearer answers 401", async () => {
    const response = await post("/query", QUERY, WRONG_BEARER);
    expect(response.status).toBe(401);
  });

  test("an optional route is guarded too", async () => {
    const response = await post("/size", { table: "t", credentials: CREDS, timeoutMs: 1000 }, JSON_ONLY);
    expect(response.status).toBe(401);
  });
});

describe("body parsing", () => {
  test("invalid JSON answers 400, never 422", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const response = await post("/query", "{nope");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "bad_request", message: "malformed request body" },
    });
    logged.mockRestore();
  });

  test("a schema-invalid body answers 400 with the issue paths", async () => {
    const response = await post("/query", { ...QUERY, table: 5 });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("table");
  });

  test("an authed body without credentials answers 400", async () => {
    const { credentials: _dropped, ...credless } = QUERY;
    const response = await post("/query", credless);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("credentials");
  });
});

describe("check", () => {
  test("credentials the connector accepts answer ok", async () => {
    const response = await post("/check", { credentials: CREDS, timeoutMs: 1000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("a wrong bearer answers 401 before the credentials are read", async () => {
    const response = await post("/check", { credentials: CREDS, timeoutMs: 1000 }, WRONG_BEARER);
    expect(response.status).toBe(401);
  });

  test("a failed check answers 400 with the connector's own message", async () => {
    const response = await post("/check", { credentials: { apiKey: "wrong" }, timeoutMs: 1000 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "check_failed", message: "lark rejected the app secret" },
    });
  });

  test("a ConnectorError from check keeps its own status and code", async () => {
    const response = await post("/check", { credentials: { apiKey: "malformed" }, timeoutMs: 1000 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "bad_request", message: "missing credentials: appToken" },
    });
  });

  test("a check that never resolves answers 408 at the request's own timeoutMs", async () => {
    const response = await post("/check", { credentials: { apiKey: "slow" }, timeoutMs: 30 });
    expect(response.status).toBe(408);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("timeout");
  });
});

describe("query", () => {
  test("answers ndjson frames ending in {end:1}", async () => {
    const response = await post("/query", QUERY);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await lines(response)).toEqual([
      { served: { filters: false, sort: true, window: false } },
      { rows: [{ a: 1 }] },
      { rows: [{ a: 2 }] },
      { end: 1 },
    ]);
  });

  test("a connector error crosses as a stream line, with no successful end marker", async () => {
    expect(await lines(await post("/query", { ...QUERY, table: "missing" }))).toEqual([
      { error: { code: "unknown_entity", message: "unknown table missing" } },
    ]);
  });
});

describe("answers", () => {
  test("/count wraps count", async () => {
    const response = await post("/count", { table: "t", and: [], credentials: CREDS, timeoutMs: 1000 });
    expect(await response.json()).toEqual({ count: 7 });
  });

  test("/discovery answers tables and warnings unwrapped further", async () => {
    const response = await post("/discovery", { credentials: CREDS, timeoutMs: 1000 });
    expect(await response.json()).toEqual({ tables: [], warnings: ["w1"] });
  });

  test("/size wraps the row count and its tier", async () => {
    const response = await post("/size", { table: "t", credentials: CREDS, timeoutMs: 1000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ size: { rows: 10, exact: true } });
  });

  test("a table the source keeps no total for answers null inside the wrapper", async () => {
    const response = await post("/size", { table: "unsized", credentials: CREDS, timeoutMs: 1000 });
    expect(await response.json()).toEqual({ size: null });
  });

  test("/cardinality answers per column, null for one the source cannot count", async () => {
    const response = await post("/cardinality", {
      table: "t",
      columns: ["a", "b"],
      credentials: CREDS,
      timeoutMs: 1000,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ columns: { a: { nonNull: 2, distinct: 2 }, b: null } });
  });

  test("/linkHitRate answers the orphan measurement", async () => {
    const response = await post("/linkHitRate", {
      fromTable: "t",
      fromColumn: "a",
      toTable: "u",
      toColumn: "id",
      credentials: CREDS,
      timeoutMs: 1000,
    });
    expect(await response.json()).toEqual({
      fromNonNull: 4,
      orphanCount: 1,
      orphanRate: 0.25,
      orphanSamples: ["ghost"],
    });
  });
});

describe("unimplemented optionals", () => {
  const bare = createApp(new BareConnector(), { token: TOKEN });

  test.each(["/size", "/count", "/aggregate", "/cardinality", "/linkHitRate"])(
    "%s is not mounted at all, so Atlas never posts one the connector cannot answer",
    async (path) => {
      const warned = spyOn(console, "warn").mockImplementation(() => {});
      const body = { table: "t", credentials: CREDS, timeoutMs: 1000 };
      const response = await postTo(bare, path, body);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "not_found", message: "no such route" } });
      warned.mockRestore();
    },
  );
});

describe("aggregate", () => {
  const AGG = {
    and: [],
    groupBy: [],
    measures: [],
    stringFields: [],
    limit: 100,
    credentials: CREDS,
    timeoutMs: 1000,
  };

  test("an undefined answer is a 204 decline", async () => {
    const response = await post("/aggregate", { ...AGG, table: "declined" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("rows are wrapped like a query answer", async () => {
    const response = await post("/aggregate", { ...AGG, table: "t" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [{ g: "x", n: 3 }] });
  });
});

describe("errors", () => {
  test("a ConnectorError keeps its status and code", async () => {
    const response = await post("/cardinality", {
      table: "missing",
      columns: ["a"],
      credentials: CREDS,
      timeoutMs: 1000,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "unknown_entity", message: "unknown table missing" },
    });
  });

  test("an unknown throw is a sanitized 500, logged server-side, never on the wire", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    expect(await lines(await post("/query", { ...QUERY, table: "explodes" }))).toEqual([
      { error: { code: "internal", message: "internal error" } },
    ]);
    expect(logged.mock.calls.length).toBe(1);
    logged.mockRestore();
  });

  test("a ConnectorError from another sdk copy still maps to its own status", async () => {
    const foreign = createApp(new ForeignErrorConnector(), { token: TOKEN });
    const response = await postTo(foreign, "/query", QUERY);
    expect(await lines(response)).toEqual([
      { error: { code: "unknown_entity", message: "unknown table 'ghost'" } },
    ]);
  });

  test("an unknown path is a quiet 404: one warn line, no stack", async () => {
    const warned = spyOn(console, "warn").mockImplementation(() => {});
    const errored = spyOn(console, "error").mockImplementation(() => {});
    const response = await post("/nope", {});
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "no such route" } });
    expect(warned.mock.calls.length).toBe(1);
    expect(errored.mock.calls.length).toBe(0);
    warned.mockRestore();
    errored.mockRestore();
  });

  test("an optional route honors the request's own timeoutMs with a 408", async () => {
    class Slow extends RouteTestConnector {
      override async size(): Promise<EntitySize | null> {
        return await new Promise(() => {});
      }
    }
    const slow = createApp(new Slow(), { token: TOKEN });
    const response = await postTo(slow, "/size", { table: "t", credentials: CREDS, timeoutMs: 30 });
    expect(response.status).toBe(408);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("timeout");
  });
});
