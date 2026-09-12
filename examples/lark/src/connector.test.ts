import { afterEach, describe, expect, test } from "bun:test";
import type { Filter, QueryChunk, Served, SourceRow, UserSort } from "@futurity/atlas-connector";
import { CAPABILITY } from "./capability";
import { LarkConnector } from "./connector";
import type { LarkField, LarkFilter, LarkSortKey } from "./lark-api";
import { LARK_PUSHDOWN, planFilter, planSort, recordIdLookup, servedBy } from "./pushdown";

const TENANT_A = { appId: "cli_a", appSecret: "secret-a", appToken: "base-x" };
const WRONG_SECRET = { ...TENANT_A, appSecret: "not-the-secret" };
const MISSING_BASE = { ...TENANT_A, appToken: "base-missing" };
const MINT_PATH = "/open-apis/auth/v3/tenant_access_token/internal";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// the lark endpoints discovery() walks, from one fixture base
function stubLark(intercept?: (pathname: string) => Response | undefined): string[] {
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    paths.push(url.pathname);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    const intercepted = intercept?.(url.pathname);
    if (intercepted) return intercepted;

    if (url.pathname === MINT_PATH) {
      const sent = JSON.parse(String(init?.body)) as { app_secret: string };
      if (sent.app_secret !== TENANT_A.appSecret) return json({ code: 10003, msg: "app secret invalid" });
      return json({ code: 0, msg: "ok", tenant_access_token: "t-a", expire: 7200 });
    }
    if (url.pathname.endsWith("/tables")) {
      if (url.pathname.includes("/apps/base-missing/")) return json({ code: 91402, msg: "NOTEXIST" });
      return json({ code: 0, msg: "ok", data: { items: [{ table_id: "tbl1", name: "deals" }], has_more: false } });
    }
    if (url.pathname.endsWith("/fields")) {
      return json({
        code: 0,
        msg: "ok",
        data: { items: [{ field_name: "name", type: 1, ui_type: "Text" }], has_more: false },
      });
    }
    if (url.pathname.endsWith("/records/search")) {
      return json({
        code: 0,
        msg: "ok",
        data: { items: [{ record_id: "rec1", fields: { name: "acme" } }], has_more: false, total: 1 },
      });
    }
    return json({ code: 99999, msg: `unstubbed ${url.pathname}` });
  }) as typeof fetch;
  return paths;
}

const req = (credentials: Record<string, string>) => ({ credentials, timeoutMs: 5000 });

describe("per-tenant isolation", () => {
  test("a wrong secret never reads another credential set's cached tables", async () => {
    const paths = stubLark();
    const connector = new LarkConnector();

    const mine = await connector.discovery(req(TENANT_A));
    expect(mine.tables.map((table) => table.name)).toEqual(["deals"]);

    paths.length = 0;
    await expect(connector.discovery(req(WRONG_SECRET))).rejects.toThrow(/app secret invalid/);
    // only the mint ran: nothing came out of the other tenant's cache
    expect(paths).toEqual([MINT_PATH]);
  });

  test("a 1254290 rate limit backs off and retries within the deadline", async () => {
    let searchCalls = 0;
    stubLark((pathname) => {
      if (!pathname.endsWith("/records/search")) return undefined;
      searchCalls += 1;
      if (searchCalls > 1) return undefined;
      return new Response(JSON.stringify({ code: 1254290, msg: "TooManyRequest" }), { status: 400 });
    });

    const answer = await new LarkConnector().discovery(req(TENANT_A));
    expect(answer.tables.map((table) => table.name)).toEqual(["deals"]);
    expect(searchCalls).toBe(2);
  });

  test("check reports the mint failure and passes on the request's own deadline", async () => {
    stubLark();
    const connector = new LarkConnector();
    await expect(connector.check(req(WRONG_SECRET))).rejects.toThrow(/app secret invalid/);
    await connector.check(req(TENANT_A));
  });

  test("check names the base and the collaborator step when the app token opens nothing", async () => {
    stubLark();
    await expect(new LarkConnector().check(req(MISSING_BASE))).rejects.toThrow(
      /base base-missing .*collaborator.*NOTEXIST/,
    );
  });
});

// #region pushdown declaration

const amount: LarkField = { field_name: "amount", type: 2 };
const owner: LarkField = { field_name: "owner", type: 1 };
const stage: LarkField = { field_name: "stage", type: 3, property: { options: [{ name: "Won" }, { name: "Lost" }] } };
const active: LarkField = { field_name: "active", type: 7 };
const closeDate: LarkField = { field_name: "close_date", type: 5 };
const score: LarkField = { field_name: "score", type: 20 };

const FIELDS = new Map(
  [amount, owner, stage, active, closeDate, score].map((field) => [field.field_name, field] as const),
);

const plan = (and: Filter[], or?: Filter[][]) => planFilter(and, or, FIELDS);

describe("filter pushdown", () => {
  test("advertises exactly the ops some field type pushes", () => {
    const ops = ["eq", "neq", "gt", "gte", "lt", "lte", "includes", "startswith", "isnull", "notnull"] as const;
    expect(LARK_PUSHDOWN.ops).toEqual(ops);
    expect(CAPABILITY.capabilities.operators).toEqual([...(LARK_PUSHDOWN.ops ?? [])]);
  });

  test("number comparisons push exactly", () => {
    expect(plan([{ field: "amount", op: "gt", value: 500000 }])).toEqual({
      filter: { conjunction: "and", conditions: [{ field_name: "amount", operator: "isGreater", value: ["500000"] }] },
      exact: true,
    });
  });

  test("a number condition carries the plain decimal atlas compares against", () => {
    expect(plan([{ field: "amount", op: "eq", value: 1e-7 }])).toEqual({
      filter: { conjunction: "and", conditions: [{ field_name: "amount", operator: "is", value: ["0.0000001"] }] },
      exact: true,
    });
    // lark reads 1e6 as a million, so the spelling never pushes
    expect(plan([{ field: "amount", op: "eq", value: "1e6" }])).toEqual({ exact: false });
  });

  test("text ops push as a superset, since lark matches case-insensitively and trims the needle", () => {
    expect(plan([{ field: "owner", op: "eq", value: "Tomas Weber" }])).toEqual({
      filter: { conjunction: "and", conditions: [{ field_name: "owner", operator: "is", value: ["Tomas Weber"] }] },
      exact: false,
    });
    expect(plan([{ field: "owner", op: "startswith", value: "Tom" }])).toEqual({
      filter: { conjunction: "and", conditions: [{ field_name: "owner", operator: "contains", value: ["Tom"] }] },
      exact: false,
    });
    // an inverted loose match would drop rows a byte-exact neq keeps
    expect(plan([{ field: "owner", op: "neq", value: "Tomas Weber" }])).toEqual({ exact: false });
  });

  test("a select value naming a live option pushes exactly; any other value stays local", () => {
    expect(plan([{ field: "stage", op: "eq", value: "Won" }])).toEqual({
      filter: { conjunction: "and", conditions: [{ field_name: "stage", operator: "is", value: ["Won"] }] },
      exact: true,
    });
    // a value naming no option fails the whole search (1254018)
    expect(plan([{ field: "stage", op: "eq", value: "WON" }])).toEqual({ exact: false });
  });

  test("emptiness pushes on every type but a checkbox, which is never empty", () => {
    expect(plan([{ field: "owner", op: "isnull" }])).toEqual({
      filter: { conjunction: "and", conditions: [{ field_name: "owner", operator: "isEmpty", value: [] }] },
      exact: true,
    });
    expect(plan([{ field: "active", op: "notnull" }])).toEqual({ exact: false });
  });

  test("formula and lookup fields carry no condition at all", () => {
    expect(plan([{ field: "score", op: "gt", value: 1 }])).toEqual({ exact: false });
  });

  test("an or of two groups rides as children, with the shared and[] distributed into each", () => {
    const or: Filter[][] = [
      [{ field: "stage", op: "eq", value: "Won" }],
      [{ field: "stage", op: "eq", value: "Lost" }],
    ];
    expect(plan([{ field: "amount", op: "gt", value: 100 }], or)).toEqual({
      filter: {
        conjunction: "or",
        children: [
          {
            conjunction: "and",
            conditions: [
              { field_name: "amount", operator: "isGreater", value: ["100"] },
              { field_name: "stage", operator: "is", value: ["Won"] },
            ],
          },
          {
            conjunction: "and",
            conditions: [
              { field_name: "amount", operator: "isGreater", value: ["100"] },
              { field_name: "stage", operator: "is", value: ["Lost"] },
            ],
          },
        ],
      },
      exact: true,
    });
  });

  test("a branch that pushes nothing leaves only the shared and[] narrowing the fetch", () => {
    const or: Filter[][] = [[{ field: "stage", op: "eq", value: "Won" }], [{ field: "score", op: "gt", value: 1 }]];
    expect(plan([{ field: "amount", op: "gt", value: 100 }], or)).toEqual({
      filter: { conjunction: "and", conditions: [{ field_name: "amount", operator: "isGreater", value: ["100"] }] },
      exact: false,
    });
  });
});

describe("sort pushdown", () => {
  const sort = (keys: UserSort[]): LarkSortKey[] | null => planSort(keys, FIELDS);

  test("numbers, text and dates push, in the order atlas asked for", () => {
    expect(sort([{ field: "amount", dir: "desc" }, { field: "owner", dir: "asc" }])).toEqual([
      { field_name: "amount", desc: true },
      { field_name: "owner", desc: false },
    ]);
    expect(sort([{ field: "close_date", dir: "asc" }])).toEqual([{ field_name: "close_date", desc: false }]);
  });

  test("a select sort stays with the host: lark orders options, not their names", () => {
    expect(sort([{ field: "stage", dir: "asc" }])).toBeNull();
    expect(sort([{ field: "record_id", dir: "asc" }])).toBeNull();
  });
});

describe("served plan", () => {
  test("only an exact filter under a pushed sort answers on its own", () => {
    const exact = plan([{ field: "amount", op: "gt", value: 1 }]);
    const superset = plan([{ field: "owner", op: "eq", value: "Ana" }]);
    expect(servedBy(exact, [])).toEqual({ filters: true, sort: true, window: true });
    expect(servedBy(exact, null)).toEqual({ filters: true, sort: false, window: false });
    expect(servedBy(superset, [])).toEqual({ filters: false, sort: true, window: false });
  });
});

describe("record id lookup", () => {
  test("an eq on record_id names the row to read", () => {
    expect(recordIdLookup([{ field: "record_id", op: "eq", value: "recABC" }])).toBe("recABC");
    expect(recordIdLookup([{ field: "record_id", op: "neq", value: "recABC" }])).toBeNull();
    expect(recordIdLookup([{ field: "owner", op: "eq", value: "recABC" }])).toBeNull();
  });
});

// #endregion

// #region wire behaviour

type Search = { filter?: LarkFilter; sort?: LarkSortKey[]; pageSize: string | null };

// stubLark's base with a two-field table, recording every search body and page size
function stubSearches(rows: { record_id: string; fields: Record<string, unknown> }[], total = 42) {
  const searches: Search[] = [];
  const gets: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname === MINT_PATH) return json({ code: 0, msg: "ok", tenant_access_token: "t-a", expire: 7200 });
    if (url.pathname.endsWith("/tables")) {
      return json({ code: 0, msg: "ok", data: { items: [{ table_id: "tbl1", name: "deals" }], has_more: false } });
    }
    if (url.pathname.endsWith("/fields")) {
      return json({
        code: 0,
        msg: "ok",
        data: {
          items: [
            { field_name: "amount", type: 2, ui_type: "Number" },
            { field_name: "owner", type: 1, ui_type: "Text" },
          ],
          has_more: false,
        },
      });
    }
    if (url.pathname.endsWith("/records/search")) {
      const body = JSON.parse(String(init?.body)) as { filter?: LarkFilter; sort?: LarkSortKey[] };
      searches.push({
        ...(body.filter ? { filter: body.filter } : {}),
        ...(body.sort ? { sort: body.sort } : {}),
        pageSize: url.searchParams.get("page_size"),
      });
      return json({ code: 0, msg: "ok", data: { items: rows, has_more: false, total } });
    }
    const record = url.pathname.match(/\/records\/(rec[^/]+)$/);
    if (record) {
      gets.push(record[1] as string);
      const found = rows.find((row) => row.record_id === record[1]);
      if (!found) return json({ code: 1254043, msg: "RecordIdNotFound" });
      return json({ code: 0, msg: "ok", data: { record: found } });
    }
    throw new Error(`unstubbed ${url.pathname}`);
  }) as typeof fetch;
  return { searches, gets };
}

const THREE_ROWS = [
  { record_id: "a", fields: { amount: 5, owner: "Tomas Weber" } },
  { record_id: "b", fields: { amount: 2, owner: "Ana" } },
  { record_id: "c", fields: {} },
];

const query = (extra: Record<string, unknown>) => ({
  table: "deals",
  and: [] as Filter[],
  sort: [] as UserSort[],
  fields: ["amount"],
  credentials: TENANT_A,
  timeoutMs: 5000,
  ...extra,
});

async function collect(chunks: AsyncIterable<QueryChunk>): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for await (const chunk of chunks) {
    if (Array.isArray(chunk)) rows.push(...chunk);
  }
  return rows;
}

async function servedFor(chunks: AsyncIterable<QueryChunk>): Promise<Served | undefined> {
  for await (const chunk of chunks) {
    if (!Array.isArray(chunk)) return chunk.served;
  }
  return undefined;
}

describe("query", () => {
  test("a sorted top-N is one page, sorted upstream, with nulls last as lark leaves them", async () => {
    const { searches } = stubSearches(THREE_ROWS);
    const rows = await collect(
      new LarkConnector().query(query({ sort: [{ field: "amount", dir: "desc" }], limit: 3 })),
    );
    expect(rows.map((row) => row.amount)).toEqual([5, 2, null]);
    expect(searches).toEqual([{ sort: [{ field_name: "amount", desc: true }], pageSize: "3" }]);
  });

  test("a sort lark orders differently is left whole for the host, limit included", async () => {
    const { searches } = stubSearches(THREE_ROWS);
    const rows = await collect(
      new LarkConnector().query(query({ and: [{ field: "owner", op: "eq", value: "Ana" }], sort: [], limit: 1 })),
    );
    // the text eq matched loosely, so windowing here would drop rows the host needs
    expect(rows.length).toBe(3);
    expect(searches[0]?.pageSize).toBe("500");
  });

  test("an eq on record_id reads one record, with no search at all", async () => {
    const { searches, gets } = stubSearches(THREE_ROWS);
    const rows = await collect(
      new LarkConnector().query(query({ and: [{ field: "record_id", op: "eq", value: "recb" }], fields: ["amount"] })),
    );
    expect(gets).toEqual(["recb"]);
    expect(searches).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("a record id naming no row answers no rows", async () => {
    const rows = [{ record_id: "recb", fields: { amount: 2 } }];
    const { gets } = stubSearches(rows);
    const answer = await collect(
      new LarkConnector().query(query({ and: [{ field: "record_id", op: "eq", value: "recb" }] })),
    );
    expect(gets).toEqual(["recb"]);
    expect(answer).toEqual([{ amount: 2 }]);
  });

  test("the single-record read's own spelling of a number flattens like a search row's", async () => {
    stubSearches([]);
    const withGetShape = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (/\/records\/rec/.test(url.pathname)) {
        // records/{record_id} answers a number as decimal text
        return new Response(
          JSON.stringify({ code: 0, data: { record: { record_id: "recz", fields: { amount: "2266224.54" } } } }),
          { status: 200 },
        );
      }
      return await withGetShape(input, init);
    }) as typeof fetch;

    const rows = await collect(
      new LarkConnector().query(query({ and: [{ field: "record_id", op: "eq", value: "recz" }] })),
    );
    expect(rows).toEqual([{ amount: 2266224.54 }]);
  });

  test("an or of two groups is one search under a children filter", async () => {
    const { searches } = stubSearches(THREE_ROWS);
    await collect(
      new LarkConnector().query(
        query({
          or: [[{ field: "amount", op: "eq", value: 5 }], [{ field: "amount", op: "eq", value: 2 }]],
          limit: 10,
        }),
      ),
    );
    expect(searches).toEqual([
      {
        filter: {
          conjunction: "or",
          children: [
            { conjunction: "and", conditions: [{ field_name: "amount", operator: "is", value: ["5"] }] },
            { conjunction: "and", conditions: [{ field_name: "amount", operator: "is", value: ["2"] }] },
          ],
        },
        pageSize: "10",
      },
    ]);
  });

  test("an unknown field is a 422, never rows the filter never touched", async () => {
    stubSearches(THREE_ROWS);
    await expect(collect(new LarkConnector().query(query({ and: [{ field: "nope", op: "isnull" }] })))).rejects.toThrow(
      /unknown field 'nope'/,
    );
  });
});

describe("count and size", () => {
  const countRequest = (and: Filter[], or?: Filter[][]) => ({
    table: "deals",
    and,
    ...(or ? { or } : {}),
    credentials: TENANT_A,
    timeoutMs: 5000,
  });

  test("a number filter is counted by one search page's total", async () => {
    const { searches } = stubSearches(THREE_ROWS);
    expect(await new LarkConnector().count(countRequest([{ field: "amount", op: "gte", value: 5 }]))).toBe(42);
    expect(searches).toEqual([
      {
        filter: { conjunction: "and", conditions: [{ field_name: "amount", operator: "isGreaterEqual", value: ["5"] }] },
        pageSize: "1",
      },
    ]);
  });

  test("an exact or is counted by one search page's total too", async () => {
    const { searches } = stubSearches(THREE_ROWS);
    const or: Filter[][] = [[{ field: "amount", op: "eq", value: 5 }], [{ field: "amount", op: "eq", value: 2 }]];
    expect(await new LarkConnector().count(countRequest([], or))).toBe(42);
    expect(searches.map((search) => search.pageSize)).toEqual(["1"]);
  });

  test("a text filter is declined, since lark counts its own looser match", async () => {
    const { searches } = stubSearches(THREE_ROWS);
    await expect(new LarkConnector().count(countRequest([{ field: "owner", op: "eq", value: "Ana" }]))).rejects.toThrow(
      /lark counts only filters it evaluates as atlas does/,
    );
    // nothing was walked to find that out
    expect(searches).toEqual([]);
  });

  test("size is the whole table's total in one request", async () => {
    const { searches } = stubSearches(THREE_ROWS, 20_000);
    expect(await new LarkConnector().size({ table: "deals", credentials: TENANT_A, timeoutMs: 5000 })).toEqual({
      rows: 20_000,
      exact: true,
    });
    expect(searches).toEqual([{ pageSize: "1" }]);
  });
});

// #endregion
