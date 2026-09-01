import { describe, expect, spyOn, test } from "bun:test";
import { AtlasConnector } from "../connector";
import type { AtlasJson } from "../wire/atlas-json";
import type {
  AggregateRequest,
  CheckRequest,
  DiscoveryAnswer,
  GrainProbe,
  NativeQueryRequest,
  TableColumnsProbe,
} from "../wire/schemas";
import type { SourceRow } from "../wire/vocabulary";
import { badRequest, unknownEntity } from "./errors";
import { createApp } from "./serve";

const TOKEN = "0123456789abcdef0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const CREDS = { apiKey: "right-key" };

const DOC: AtlasJson = {
  protocolVersion: 1,
  slug: "route-test",
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
  credentialSchema: [{ key: "apiKey", label: "API key", type: "password", required: true }],
  endpoints: ["aggregate"],
};

class RouteTestConnector extends AtlasConnector {
  readonly slug = "route-test";
  capability(): AtlasJson {
    return DOC;
  }
  async check(req: CheckRequest): Promise<void> {
    if (req.credentials.apiKey === "malformed") throw badRequest("missing credentials: appToken");
    if (req.credentials.apiKey === "slow") await new Promise(() => {});
    if (req.credentials.apiKey !== CREDS.apiKey) throw new Error("lark rejected the app secret");
  }
  async discover(): Promise<DiscoveryAnswer> {
    return { tables: [], warnings: ["w1"] };
  }
  async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    if (req.table === "missing") throw unknownEntity(`unknown table ${req.table}`);
    if (req.table === "explodes") throw new Error("password=hunter2 leaked stack");
    if (req.table === "slow") await new Promise(() => {});
    yield [{ a: 1 }];
    yield [{ a: 2 }];
  }
  async count(): Promise<number> {
    return 7;
  }
  override async sampleColumnValues(): Promise<string[]> {
    return ["1", "2"];
  }
  override async profileGrain(): Promise<GrainProbe | null> {
    return { rows: 10, distinct: 10, nonNull: 10 };
  }
  override async aggregate(req: AggregateRequest): Promise<SourceRow[] | undefined> {
    if (req.table === "declined") return undefined;
    return [{ g: "x", n: 3 }];
  }
}

class DeclinesProfiling extends RouteTestConnector {
  override async profileColumns(): Promise<TableColumnsProbe | null> {
    return null;
  }
}

const app = createApp(new RouteTestConnector(), { token: TOKEN });

function post(path: string, body: unknown, headers: Record<string, string> = AUTH): Promise<Response> {
  return app.handle(
    new Request(`http://connector.test${path}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const QUERY = { table: "t", and: [], sort: [], fields: ["a"], credentials: CREDS, timeoutMs: 1000 };

describe("well-known", () => {
  test("serves the capability doc without auth", async () => {
    const response = await app.handle(new Request("http://connector.test/.well-known/futurity/atlas.json"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DOC);
  });
});

describe("auth", () => {
  test("a data endpoint without a bearer answers the 401 envelope", async () => {
    const response = await post("/query", QUERY, { "content-type": "application/json" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "missing bearer token" },
    });
  });

  test("a wrong bearer answers 401", async () => {
    const response = await post("/query", QUERY, {
      authorization: `Bearer ${"x".repeat(32)}`,
      "content-type": "application/json",
    });
    expect(response.status).toBe(401);
  });

  test("the stream endpoint is guarded too", async () => {
    const response = await post("/query/stream", { ...QUERY, idleTimeoutMs: 100, maxTimeoutMs: 1000 }, {
      "content-type": "application/json",
    });
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
    const response = await post("/check", { credentials: CREDS, timeoutMs: 1000 }, {
      authorization: `Bearer ${"x".repeat(32)}`,
      "content-type": "application/json",
    });
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

describe("answers", () => {
  test("/query drains the batches into one rows body", async () => {
    const response = await post("/query", QUERY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [{ a: 1 }, { a: 2 }] });
  });

  test("/query stops at the request's limit", async () => {
    const response = await post("/query", { ...QUERY, limit: 1 });
    expect(await response.json()).toEqual({ rows: [{ a: 1 }] });
  });

  test("/count wraps count", async () => {
    const response = await post("/count", { table: "t", and: [], credentials: CREDS, timeoutMs: 1000 });
    expect(await response.json()).toEqual({ count: 7 });
  });

  test("/discovery answers tables and warnings unwrapped further", async () => {
    const response = await post("/discovery", { credentials: CREDS, timeoutMs: 1000 });
    expect(await response.json()).toEqual({ tables: [], warnings: ["w1"] });
  });

  test("/sample/keyValues wraps values", async () => {
    const response = await post("/sample/keyValues", {
      table: "t",
      column: "a",
      type: "number",
      limit: 10,
      credentials: CREDS,
      timeoutMs: 1000,
    });
    expect(await response.json()).toEqual({ values: ["1", "2"] });
  });

  test("/count/exact answers the derived count inside the wrapper", async () => {
    const response = await post("/count/exact", { table: "t", credentials: CREDS, timeoutMs: 1000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 2 });
  });

  test("/probe/columns answers the profile derived from query", async () => {
    const response = await post("/probe/columns", {
      table: "t",
      columns: ["a"],
      credentials: CREDS,
      timeoutMs: 1000,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      rows: 2,
      columns: { a: { nonNull: 2, distinct: 2, duplicates: { valueCount: 0, maxMultiplicity: 1 } } },
    });
  });

  test("a declining probe answers a JSON null body", async () => {
    const declines = createApp(new DeclinesProfiling(), { token: TOKEN });
    const response = await declines.handle(
      new Request("http://connector.test/probe/columns", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ table: "t", columns: ["a"], credentials: CREDS, timeoutMs: 1000 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("null");
  });

  test("an overridden probe answers its shape", async () => {
    const response = await post("/probe/grain", {
      table: "t",
      column: "a",
      credentials: CREDS,
      timeoutMs: 1000,
    });
    expect(await response.json()).toEqual({ rows: 10, distinct: 10, nonNull: 10 });
  });
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
    const response = await post("/query", { ...QUERY, table: "missing" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "unknown_entity", message: "unknown table missing" },
    });
  });

  test("an unknown throw is a sanitized 500, logged server-side, never on the wire", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const response = await post("/query", { ...QUERY, table: "explodes" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "internal error" } });
    expect(logged.mock.calls.length).toBe(1);
    logged.mockRestore();
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

  test("the request's own timeoutMs is honored with a 408", async () => {
    const response = await post("/query", { ...QUERY, table: "slow", timeoutMs: 30 });
    expect(response.status).toBe(408);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("timeout");
  });
});

describe("stream route", () => {
  test("answers ndjson frames ending in {end:1}", async () => {
    const response = await post("/query/stream", { ...QUERY, idleTimeoutMs: 1000, maxTimeoutMs: 5000 });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await response.text())
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([{ rows: [{ a: 1 }] }, { rows: [{ a: 2 }] }, { end: 1 }]);
  });
});
