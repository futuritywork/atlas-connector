// outside the connector workspaces, so it resolves the SDK as the shared host does
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, type NativeQueryStreamRequest } from "@futurity/atlas-connector";
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

const query: NativeQueryStreamRequest = {
  credentials,
  timeoutMs: 1_000,
  idleTimeoutMs: 1_000,
  maxTimeoutMs: 2_000,
  table: "branches",
  fields: ["branchID"],
  and: [],
  sort: [],
  limit: 1,
};

const app = new Elysia()
  .group("/esb-core", (group) => group.use(createApp(new EsbCoreConnector(), { token: TOKEN })))
  .group("/lark-base", (group) => group.use(createApp(new LarkConnector(), { token: TOKEN })));

// /query is ndjson only: an error is a terminal {error} line, never a status
async function lines(response: Response): Promise<unknown[]> {
  return (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function answer(response: Response): Promise<{ plan: unknown; rows: unknown[] }> {
  const framed = await lines(response);
  expect(framed.at(-1)).toEqual({ end: 1 });
  return {
    plan: framed.find((line) => "served" in (line as object)),
    rows: framed.flatMap((line) => (line as { rows?: unknown[] }).rows ?? []),
  };
}

async function rows(response: Response): Promise<unknown[]> {
  return (await answer(response)).rows;
}

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

  test("/query preserves unknown-entity errors", async () => {
    expect(await lines(await post("/query", { ...query, table: "missing" }))).toEqual([
      { error: { code: "unknown_entity", message: 'unknown table "missing"' } },
    ]);
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
  ] satisfies Partial<NativeQueryStreamRequest>[])(
    "preserves unsupported query errors: %j",
    async (overrides) => {
      const response = await post("/query", { ...query, ...overrides });
      expect(response.headers.get("content-type")).toBe("application/x-ndjson");
      expect(await lines(response)).toEqual([
        { error: { code: "unsupported", message: expect.any(String) } },
      ]);
    },
  );

  test("rejects a wrong bearer before connector validation", async () => {
    const response = await post("/discovery", { credentials: {}, timeoutMs: 1_000 }, "wrong");
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
  });
});

type LarkCondition = { field_name: string; operator: string; value?: string[] };

// numbers numerically, text case-insensitively; only these operators are stubbed
function matchesCondition(fields: Record<string, unknown>, condition: LarkCondition): boolean {
  const value = fields[condition.field_name];
  const wanted = condition.value?.[0] ?? "";
  if (value === undefined) return false;
  if (condition.operator === "isGreaterEqual") return Number(value) >= Number(wanted);
  if (condition.operator !== "is") throw new Error(`unstubbed Lark operator ${condition.operator}`);
  return typeof value === "number" ? Number(wanted) === value : String(value).toLowerCase() === wanted.toLowerCase();
}

// empty cells last in both directions, the way bitable orders
function sortLikeLark(
  items: { record_id: string; fields: Record<string, unknown> }[],
  sort: { field_name: string; desc: boolean }[],
) {
  return [...items].sort((left, right) => {
    for (const key of sort) {
      const a = left.fields[key.field_name];
      const b = right.fields[key.field_name];
      if (a === undefined || b === undefined) {
        if (a === undefined && b === undefined) continue;
        return a === undefined ? 1 : -1;
      }
      if (a === b) continue;
      const order = typeof a === "number" && typeof b === "number" ? (a < b ? -1 : 1) : String(a) < String(b) ? -1 : 1;
      return key.desc ? -order : order;
    }
    return 0;
  });
}

const larkPost = (path: string, body: unknown) => post(path, body, TOKEN, "lark-base");

const LARK_ROWS: { record_id: string; fields: Record<string, unknown> }[] = [
  { record_id: "low", fields: { code: "01", amount: 2e-8 } },
  { record_id: "high", fields: { code: "01", amount: 1e-7 } },
  { record_id: "null", fields: { code: "01" } },
  { record_id: "two", fields: { code: "01", amount: 2 } },
  { record_id: "other", fields: { code: "1", amount: 100 } },
];

test("Lark pushes the filter, the sort and the id lookup upstream in the shared host", async () => {
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.endsWith("/tenant_access_token/internal")) {
      return Response.json({ code: 0, tenant_access_token: "host-lark-token", expire: 7200 });
    }
    if (path.endsWith("/tables")) {
      return Response.json({ code: 0, data: { items: [{ table_id: "tbl1", name: "deals" }], has_more: false } });
    }
    if (path.endsWith("/fields")) {
      const items = [
        { field_name: "record_id", type: 1, ui_type: "Text" },
        { field_name: "code", type: 1, ui_type: "Text" },
        { field_name: "amount", type: 2, ui_type: "Number" },
      ];
      return Response.json({ code: 0, data: { items, has_more: false } });
    }
    if (path.endsWith("/records/search")) {
      const body = (await new Request(input, init).json()) as {
        filter?: { conditions?: LarkCondition[] };
        sort?: { field_name: string; desc: boolean }[];
      };
      expect(body).not.toMatchObject({
        filter: { conditions: expect.arrayContaining([expect.objectContaining({ field_name: "record_id" })]) },
      });
      const conditions = body.filter?.conditions ?? [];
      const matched = LARK_ROWS.filter((item) =>
        conditions.every((condition) => matchesCondition(item.fields, condition)),
      );
      const ordered = body.sort ? sortLikeLark(matched, body.sort) : matched;
      // total counts the filtered rows, as a live search page does
      return Response.json({ code: 0, data: { items: ordered, has_more: false, total: matched.length } });
    }
    const record = path.match(/\/records\/([^/]+)$/);
    if (record) {
      const found = LARK_ROWS.find((item) => item.record_id === record[1]);
      if (!found) return Response.json({ code: 1254043, msg: "RecordIdNotFound" });
      return Response.json({ code: 0, data: { record: found } });
    }
    throw new Error(`unexpected Lark request ${path}`);
  }, { preconnect: realFetch.preconnect });

  const connection = {
    credentials: { appId: "host-lark", appSecret: "host-lark-secret", appToken: "host-base" },
    timeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    maxTimeoutMs: 2_000,
  };

  const discovery = await larkPost("/discovery", connection);
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

  const result = await larkPost("/query", {
    ...selection,
    fields: ["record_id", "amount"],
    sort: [{ field: "amount", dir: "desc" }],
  });
  expect(result.status).toBe(200);
  const sorted = await answer(result);
  // an eq on text is lark's loose match, so the rows stay the host's to narrow
  expect(sorted.plan).toEqual({ served: { filters: false, sort: true, window: false } });
  expect(sorted.rows).toEqual([
    { record_id: "two", amount: 2 },
    { record_id: "high", amount: 1e-7 },
    { record_id: "low", amount: 2e-8 },
    { record_id: "null", amount: null },
  ]);

  // the same loose match makes the count the host's to tally
  const countBody = {
    credentials: connection.credentials,
    timeoutMs: connection.timeoutMs,
    table: "deals",
    and: selection.and,
  };
  const count = await larkPost("/count", countBody);
  expect(count.status).toBe(422);
  expect((await count.json()).error.code).toBe("unsupported");

  // a filter lark evaluates exactly windows upstream: page one is the answer
  const window = await larkPost("/query", {
    ...selection,
    and: [{ field: "amount", op: "gte", value: 1e-7 }],
    fields: ["record_id"],
    sort: [{ field: "amount", dir: "asc" }],
    offset: 1,
    limit: 1,
  });
  expect(window.status).toBe(200);
  const windowed = await answer(window);
  expect(windowed.plan).toEqual({ served: { filters: true, sort: true, window: true } });
  expect(windowed.rows).toEqual([{ record_id: "two" }]);

  const identity = await larkPost("/query", {
    ...selection,
    and: [{ field: "record_id", op: "eq", value: "high" }],
    fields: ["record_id"],
    sort: [],
  });
  expect(identity.status).toBe(200);
  expect(await rows(identity)).toEqual([{ record_id: "high" }]);

  for (const value of [1e-7, "0.0000001"]) {
    const numeric = await larkPost("/count", { ...countBody, and: [{ field: "amount", op: "eq", value }] });
    expect(numeric.status).toBe(200);
    expect(await numeric.json()).toEqual({ count: 1 });
  }

  for (const invalid of [
    { fields: ["missing"], sort: [] },
    { fields: [], sort: [{ field: "missing", dir: "asc" }] },
    { fields: [], sort: [], or: [[{ field: "missing", op: "isnull" }]] },
  ]) {
    const rejected = await larkPost("/query", { ...selection, ...invalid });
    expect(await lines(rejected)).toEqual([
      { error: { code: "unsupported", message: expect.any(String) } },
    ]);
  }
});
