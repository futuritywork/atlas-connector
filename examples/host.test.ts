// Keep this test outside connector workspaces so it resolves the SDK like the shared host.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, type NativeQueryRequest } from "@futurity/atlas-connector";
import { Elysia } from "elysia";
import { EsbCoreConnector } from "./esb/src/connector";
import { resetEsbCoreTokenCacheForTests } from "./esb/src/esb-api";

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

const app = new Elysia().group("/esb-core", (group) =>
  group.use(createApp(new EsbCoreConnector(), { token: TOKEN })),
);

function post(path: string, body: unknown, token = TOKEN): Promise<Response> {
  return app.handle(
    new Request(`http://connector.test/esb-core${path}`, {
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
