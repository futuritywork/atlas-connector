import { describe, expect, test } from "bun:test";
import { AtlasConnector } from "../connector";
import type { AtlasJson } from "../wire/atlas-json";
import type {
  AggregateRequest,
  DiscoveryAnswer,
  GrainProbe,
  NativeQueryRequest,
  NativeQueryStreamRequest,
} from "../wire/schemas";
import type { SourceRow } from "../wire/vocabulary";
import { unknownEntity } from "./errors";
import { createApp } from "./serve";

const TOKEN = "0123456789abcdef0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

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
  endpoints: ["aggregate"],
};

class RouteTestConnector extends AtlasConnector {
  readonly slug = "route-test";
  capability(): AtlasJson {
    return DOC;
  }
  async discovery(): Promise<DiscoveryAnswer> {
    return { tables: [], warnings: ["w1"] };
  }
  async query(req: NativeQueryRequest): Promise<SourceRow[]> {
    if (req.table === "missing") throw unknownEntity(`unknown table ${req.table}`);
    if (req.table === "explodes") throw new Error("password=hunter2 leaked stack");
    if (req.table === "slow") await new Promise(() => {});
    return [{ a: 1 }];
  }
  async *queryStream(_req: NativeQueryStreamRequest): AsyncIterable<SourceRow[]> {
    yield [{ a: 1 }];
    yield [{ a: 2 }];
  }
  async count(): Promise<number> {
    return 7;
  }
  async sampleKeyValues(): Promise<string[]> {
    return ["1", "2"];
  }
  override async probeGrain(): Promise<GrainProbe | null> {
    return { rows: 10, distinct: 10, nonNull: 10 };
  }
  override async aggregate(req: AggregateRequest): Promise<SourceRow[] | undefined> {
    if (req.table === "declined") return undefined;
    return [{ g: "x", n: 3 }];
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

const QUERY = { table: "t", and: [], sort: [], fields: ["a"], timeoutMs: 1000 };

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
    const response = await post("/query", "{nope");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "bad_request", message: "malformed request body" },
    });
  });

  test("a schema-invalid body answers 400 with the issue paths", async () => {
    const response = await post("/query", { table: 5, and: [], sort: [], fields: [], timeoutMs: 1000 });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("table");
  });
});

describe("answers", () => {
  test("/query wraps rows", async () => {
    const response = await post("/query", QUERY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [{ a: 1 }] });
  });

  test("/count wraps count", async () => {
    const response = await post("/count", { table: "t", and: [], timeoutMs: 1000 });
    expect(await response.json()).toEqual({ count: 7 });
  });

  test("/discovery answers tables and warnings unwrapped further", async () => {
    const response = await post("/discovery", { timeoutMs: 1000 });
    expect(await response.json()).toEqual({ tables: [], warnings: ["w1"] });
  });

  test("/sample/keyValues wraps values", async () => {
    const response = await post("/sample/keyValues", {
      table: "t",
      column: "a",
      type: "number",
      limit: 10,
      timeoutMs: 1000,
    });
    expect(await response.json()).toEqual({ values: ["1", "2"] });
  });

  test("/count/exact base impl answers null inside the wrapper", async () => {
    const response = await post("/count/exact", { table: "t", timeoutMs: 1000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: null });
  });

  test("a base probe answers a JSON null body", async () => {
    const response = await post("/probe/columns", { table: "t", columns: ["a"], timeoutMs: 1000 });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("null");
  });

  test("an overridden probe answers its shape", async () => {
    const response = await post("/probe/grain", { table: "t", column: "a", timeoutMs: 1000 });
    expect(await response.json()).toEqual({ rows: 10, distinct: 10, nonNull: 10 });
  });
});

describe("aggregate", () => {
  const AGG = { and: [], groupBy: [], measures: [], stringFields: [], limit: 100, timeoutMs: 1000 };

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

  test("an unknown throw is a sanitized 500 — the driver message never crosses", async () => {
    const response = await post("/query", { ...QUERY, table: "explodes" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "internal error" } });
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
