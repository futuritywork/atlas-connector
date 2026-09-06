// Keep this test outside connector workspaces so it resolves the SDK like the shared host.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, type NativeQueryRequest } from "@futurity/atlas-connector";
import { Elysia } from "elysia";
import { EsbCoreConnector } from "./esb/src/connector";
import { resetEsbCoreTokenCacheForTests } from "./esb/src/esb-api";
import { LarkConnector } from "./lark/src/connector";

const TOKEN = "host-test-bearer-0123456789abcdef01234567";
const credentials = { username: "no-upstream", password: "no-upstream" };
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("host validation tests must not call upstream");
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEsbCoreTokenCacheForTests();
});

const query: NativeQueryRequest = {
  credentials,
  timeoutMs: 1_000,
  table: "branches",
  fields: ["branchID"],
  and: [],
  sort: [],
  limit: 1,
};

const app = new Elysia()
  .group("/esb-core", (group) => group.use(createApp(new EsbCoreConnector(), { token: TOKEN })))
  .group("/lark-base", (group) => group.use(createApp(new LarkConnector(), { token: TOKEN })));

function post(path: string, body: unknown, token = TOKEN, slug = "esb-core"): Promise<Response> {
  return app.handle(
    new Request(`http://connector.test/${slug}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("ESB in the shared host", () => {
  test.each(["/check", "/discovery"])("%s preserves credential validation errors", async (path) => {
    const response = await post(path, { credentials: {}, timeoutMs: 1_000 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "bad_request", message: "ESB Core username is required" },
    });
  });

  test.each(["/query", "/count"])("%s preserves unknown-entity errors", async (path) => {
    const body =
      path === "/count"
        ? { credentials, timeoutMs: 1_000, table: "missing", and: [] }
        : { ...query, table: "missing" };
    const response = await post(path, body);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "unknown_entity", message: 'unknown table "missing"' },
    });
  });

  test.each([
    { fields: ["missing"] },
    { and: [{ field: "missing", op: "eq", value: "x" }] },
    { sort: [{ field: "missing", dir: "asc" }] },
    {
      joins: [
        {
          fromTable: "branches",
          toTable: "branches",
          fromField: "branchID",
          toField: "branchID",
          fields: [],
        },
      ],
    },
  ] satisfies Partial<NativeQueryRequest>[])(
    "preserves unsupported query errors: %j",
    async (overrides) => {
      const response = await post("/query", { ...query, ...overrides });
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe("unsupported");
    },
  );

  test("preserves invalid filter operand errors", async () => {
    const response = await post("/query", {
      ...query,
      and: [{ field: "branchID", op: "eq", value: "not-a-number" }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("bad_request");
  });

  test("streams the connector error code without a successful end marker", async () => {
    const response = await post("/query/stream", {
      ...query,
      table: "missing",
      idleTimeoutMs: 1_000,
      maxTimeoutMs: 2_000,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(
      (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ error: { code: "unknown_entity", message: 'unknown table "missing"' } }]);
  });

  test("rejects a wrong bearer before connector validation", async () => {
    const response = await post("/discovery", { credentials: {}, timeoutMs: 1_000 }, "wrong");
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
  });
});

test("Lark discovery owns filtering, numeric sorting, projection, and count in the shared host", async () => {
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.endsWith("/tenant_access_token/internal")) {
      return Response.json({ code: 0, tenant_access_token: "host-lark-token", expire: 7200 });
    }
    if (path.endsWith("/tables")) {
      return Response.json({ code: 0, data: { items: [{ table_id: "tbl1", name: "deals" }], has_more: false } });
    }
    if (path.endsWith("/fields")) {
      return Response.json({ code: 0, data: { items: [
        { field_name: "record_id", type: 1, ui_type: "Text" },
        { field_name: "code", type: 1, ui_type: "Text" },
        { field_name: "amount", type: 2, ui_type: "Number" },
      ], has_more: false } });
    }
    if (path.endsWith("/records/search")) {
      expect(await new Request(input, init).json()).not.toMatchObject({
        filter: { conditions: expect.arrayContaining([expect.objectContaining({ field_name: "record_id" })]) },
      });
      return Response.json({ code: 0, data: { items: [
        { record_id: "low", fields: { code: "01", amount: 2e-8 } },
        { record_id: "high", fields: { code: "01", amount: 1e-7 } },
        { record_id: "null", fields: { code: "01" } },
        { record_id: "two", fields: { code: "01", amount: 2 } },
        { record_id: "other", fields: { code: "1", amount: 100 } },
      ], has_more: false, total: 5 } });
    }
    throw new Error(`unexpected Lark request ${path}`);
  }, { preconnect: realFetch.preconnect });

  const connection = {
    credentials: { appId: "host-lark", appSecret: "host-lark-secret", appToken: "host-base" },
    timeoutMs: 1_000,
  };
  const discovery = await post("/discovery", connection, TOKEN, "lark-base");
  expect(discovery.status).toBe(200);
  const discovered = await discovery.json();
  expect(discovered.warnings).toHaveLength(1);
  expect(discovered.tables[0]).toMatchObject({
    name: "deals",
    primaryKey: ["record_id"],
    fields: [
      { name: "record_id", type: "string", nullable: false, unique: true },
      { name: "code", type: "string", nullable: true },
      { name: "amount", type: "number", nullable: true },
    ],
  });
  const selection = {
    ...connection,
    table: "deals",
    and: [{ field: "code", op: "eq", value: "01" }],
    fieldTypes: { code: "number", amount: "string" },
  };
  const result = await post("/query", {
    ...selection,
    fields: ["record_id", "amount"],
    sort: [{ field: "amount", dir: "desc" }],
  }, TOKEN, "lark-base");
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ rows: [
    { record_id: "two", amount: 2 },
    { record_id: "high", amount: 1e-7 },
    { record_id: "low", amount: 2e-8 },
    { record_id: "null", amount: null },
  ] });
  const count = await post("/count", selection, TOKEN, "lark-base");
  expect(count.status).toBe(200);
  expect(await count.json()).toEqual({ count: 4 });
  const identity = await post("/query", {
    ...selection,
    and: [{ field: "record_id", op: "eq", value: "high" }],
    fields: ["record_id"],
    sort: [],
  }, TOKEN, "lark-base");
  expect(identity.status).toBe(200);
  expect(await identity.json()).toEqual({ rows: [{ record_id: "high" }] });
  for (const value of [1e-7, "0.0000001"]) {
    const numeric = await post("/count", {
      ...selection,
      and: [{ field: "amount", op: "eq", value }],
    }, TOKEN, "lark-base");
    expect(numeric.status).toBe(200);
    expect(await numeric.json()).toEqual({ count: 1 });
  }
  for (const invalid of [
    { fields: ["missing"], sort: [] },
    { fields: [], sort: [{ field: "missing", dir: "asc" }] },
    { fields: [], sort: [], or: [[{ field: "missing", op: "isnull" }]] },
  ]) {
    const rejected = await post("/query", { ...selection, ...invalid }, TOKEN, "lark-base");
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).error.code).toBe("unsupported");
  }
});
