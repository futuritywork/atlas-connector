import { afterEach, describe, expect, test } from "bun:test";
import {
  CONNECTOR_LIMITS,
  createApp,
  type NativeQueryRequest,
  type Served,
  type SourceRow,
} from "@futurity/atlas-connector";
import { CAPABILITY } from "./capability";
import { ESB_CORE_CATALOG } from "./catalog";
import { EsbCoreConnector } from "./connector";
import { resetEsbCoreTokenCacheForTests } from "./esb-api";
import { resetHonoredFiltersForTests } from "./helpers/negative-control";
import type { EsbCoreObject } from "./types";

const TOKEN = "0123456789abcdef0123456789abcdef";
const CREDENTIALS = { username: "atlas-reader", password: "private-password" };
const object = (name: string): EsbCoreObject => ESB_CORE_CATALOG.find((entry) => entry.name === name)!;
const PRODUCTS = object("products");
const BRANCHES = object("branches");
const ITEM_JOURNALS = object("item_journals");
const PRICELISTS = object("pricelists");
const RECEIPTS = object("receipts");
const CUSTOMERS = object("customers");
const GOODS_DELIVERIES = object("goods_deliveries");
const GOODS_RECEIPTS = object("goods_receipts");
const PURCHASE_ORDERS = object("purchase_orders");
const SIMPLE_MANUFACTURING = object("simple_manufacturing");
const UNITS = object("units");
const COST_CENTERS = object("cost_centers");
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEsbCoreTokenCacheForTests();
  resetHonoredFiltersForTests();
});

function envelope(result: unknown, status = 200): Response {
  return Response.json({ status: "ok", code: "EC03100000", message: "OK", result }, { status });
}

function token(): Response {
  return envelope({ accessToken: "access", refreshToken: "refresh" });
}

function failure(code: string, status: number, message: string): Response {
  return Response.json({ status: "fail", code, message, result: null }, { status });
}

type Call = { url: URL; init?: RequestInit };

function mockFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input, init) => {
    const call = { url: new URL(String(input)), init };
    calls.push(call);
    return await handler(call);
  }) as typeof fetch;
  return calls;
}

function objectForPath(pathname: string): EsbCoreObject | undefined {
  return ESB_CORE_CATALOG.find((entry) => pathname === `/core${entry.path}`);
}

function page(rows: Record<string, unknown>[], next = "", pageNumber = 1, limit = 100): Response {
  return envelope({ page: pageNumber, limit, data: rows, next });
}

// the params the connector pushed, minus the paging it always sends
function pushed(call: Call): Record<string, string> {
  const params = Object.fromEntries(call.url.searchParams);
  delete params.page;
  delete params.limit;
  return params;
}

function lastPushed(calls: Call[]): Record<string, string> {
  return pushed(calls.at(-1)!);
}

function isNegativeControl(call: Call): boolean {
  return Object.keys(pushed(call)).length > 0;
}

function collectionCalls(calls: Call[], entity: EsbCoreObject): Call[] {
  return calls.filter((call) => call.url.pathname === `/core${entity.path}`);
}

function mockObjectRows(
  entity: EsbCoreObject,
  pages: Record<number, { rows: Record<string, unknown>[]; next?: string }>,
): Call[] {
  return mockFetch(({ url }) => {
    if (url.pathname.endsWith("/auth/login")) return token();
    expect(url.pathname).toBe(`/core${entity.path}`);
    if (entity.mode === "direct") return envelope(pages[1]?.rows ?? []);
    const pageNumber = Number(url.searchParams.get("page"));
    const answer = pages[pageNumber] ?? { rows: [], next: "" };
    return page(answer.rows, answer.next, pageNumber);
  });
}

function query(overrides: Partial<NativeQueryRequest> = {}): NativeQueryRequest {
  return {
    table: "products",
    and: [],
    sort: [],
    fields: ["productID", "productName"],
    credentials: CREDENTIALS,
    timeoutMs: 2_000,
    ...overrides,
  };
}

// the stream's leading plan line, and the row batches after it
async function run(request: NativeQueryRequest): Promise<{ served?: Served; batches: SourceRow[][] }> {
  let served: Served | undefined;
  const batches: SourceRow[][] = [];
  for await (const chunk of new EsbCoreConnector().query(request)) {
    if (Array.isArray(chunk)) batches.push(chunk);
    else served = chunk.served;
  }
  return { served, batches };
}

async function collect(request: NativeQueryRequest): Promise<SourceRow[]> {
  return (await run(request)).batches.flat();
}

describe("ESB Core capability and catalog", () => {
  test("advertises the pushdown map the catalog carries and nothing else", () => {
    expect(new EsbCoreConnector().slug).toBe("esb-core");
    expect(CAPABILITY.slug).toBe("esb-core");
    expect(CAPABILITY.capabilities).toMatchObject({
      sort: "single",
      offset: true,
      join: false,
      keysEnforced: false,
      dateBucket: false,
      limits: { pageSizeMax: 1_000, concurrency: 4 },
    });
    expect([...CAPABILITY.capabilities.operators].sort()).toEqual(["eq", "gte", "in", "lte"]);
    expect(CAPABILITY.credentialSchema.map((entry) => [entry.key, entry.type, entry.required])).toEqual([
      ["username", "text", true],
      ["password", "password", true],
    ]);
  });

  test("contains 39 unique entities with valid unique fields and primary keys", () => {
    expect(ESB_CORE_CATALOG).toHaveLength(39);
    expect(new Set(ESB_CORE_CATALOG.map((entry) => entry.name)).size).toBe(39);
    expect(ESB_CORE_CATALOG.filter((entry) => entry.mode === "direct")).toHaveLength(3);
    for (const entry of ESB_CORE_CATALOG) {
      expect(new Set(entry.columns.map((column) => column.name)).size).toBe(entry.columns.length);
      if (entry.primaryKey) expect(entry.columns.some((column) => column.name === entry.primaryKey)).toBe(true);
    }
  });

  test("every mapped param and sort field names a catalog column of its own entity", () => {
    for (const entry of ESB_CORE_CATALOG) {
      const columns = new Set(entry.columns.map((column) => column.name));
      for (const filter of entry.filters ?? []) {
        expect(columns).toContain(filter.field);
        expect(filter.ops.length).toBeGreaterThan(0);
        // a date window spells both bounds; every other param carries one value
        expect("param" in filter || ("from" in filter && "to" in filter)).toBe(true);
      }
      for (const field of entry.sortFields ?? []) expect(columns).toContain(field);
      // a direct collection takes no query string, so it pushes neither
      if (entry.mode === "direct") expect([entry.filters, entry.sortFields]).toEqual([undefined, undefined]);
    }
  });

  test("uses plain descriptions and advertises documented date-only fields as dates", () => {
    const parentheticalDescriptions = ESB_CORE_CATALOG.flatMap((entry) =>
      entry.columns
        .filter((column) => /[()]/.test(column.description))
        .map((column) => `${entry.name}.${column.name}`),
    );
    expect(parentheticalDescriptions).toEqual([]);
    expect(PRICELISTS.columns.find((column) => column.name === "priceDate")).toMatchObject({
      type: "date",
      description: "Pricelist active date",
    });
    expect(RECEIPTS.columns.find((column) => column.name === "receiptDate")).toMatchObject({
      type: "date",
      description: "Receipt Date",
    });
  });
});

describe("ESB Core discovery", () => {
  test("maps every accessible catalog entity in catalog order", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const entity = objectForPath(url.pathname);
      if (!entity) throw new Error(`unexpected path ${url.pathname}`);
      return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    const answer = await new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(answer.tables.map((table) => table.name)).toEqual(ESB_CORE_CATALOG.map((entry) => entry.name));
    expect(answer.warnings).toBeUndefined();
    const products = answer.tables.find((table) => table.name === "products")!;
    expect(products.primaryKey).toEqual(["productID"]);
    expect(products.fields.find((field) => field.name === "productID")).toMatchObject({
      sourceColumn: "productID",
      type: "number",
      nullable: false,
      unique: true,
      samples: [],
    });
  });

  test("seeds rowCount from the availability probe: count for a paged entity, row tally for a direct one", async () => {
    const calls = mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const entity = objectForPath(url.pathname)!;
      if (entity.mode === "direct") {
        const row = { [entity.primaryKey!]: 1 };
        return envelope([row, { ...row, [entity.primaryKey!]: 2 }]);
      }
      const narrowed = isNegativeControl({ url });
      return envelope({
        page: 1,
        limit: 1,
        count: narrowed ? 0 : entity === PRODUCTS ? 22_156 : 7,
        data: [],
        next: "",
      });
    });
    const answer = await new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(answer.tables.find((table) => table.name === "products")!.rowCount).toBe(22_156);
    expect(answer.tables.find((table) => table.name === "receipts")!.rowCount).toBe(7);
    for (const entity of ESB_CORE_CATALOG.filter((entry) => entry.mode === "direct")) {
      expect(answer.tables.find((table) => table.name === entity.name)!.rowCount).toBe(2);
    }
    expect(answer.warnings).toBeUndefined();
    // one availability page per entity, then one control probe per mapped param
    const controls = ESB_CORE_CATALOG.filter((entry) => entry.mode === "paged").reduce(
      (total, entry) => total + (entry.filters?.length ?? 0),
      0,
    );
    const collections = calls.filter((call) => !call.url.pathname.endsWith("/auth/login"));
    expect(collections).toHaveLength(ESB_CORE_CATALOG.length + controls);
    expect(collections.filter(isNegativeControl)).toHaveLength(controls);
  });

  test("a rejected control value proves the endpoint reads the param, a 5xx does not", async () => {
    for (const [status, kept] of [
      [400, true],
      [500, false],
    ] as const) {
      resetEsbCoreTokenCacheForTests();
      resetHonoredFiltersForTests();
      mockFetch(({ url }) => {
        if (url.pathname.endsWith("/auth/login")) return token();
        const entity = objectForPath(url.pathname)!;
        if (entity.mode === "direct") return envelope([]);
        if (entity !== PURCHASE_ORDERS) return page([], "", 1, 1);
        if (isNegativeControl({ url })) {
          return url.searchParams.has("statusID")
            ? failure("EC03100003", status, "Validation Error")
            : envelope({ page: 1, limit: 1, count: 0, data: [], next: "" });
        }
        return envelope({ page: 1, limit: 1, count: 12, data: [], next: "" });
      });
      const answer = await new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 });
      expect(answer.warnings === undefined).toBe(kept);

      const calls = mockObjectRows(PURCHASE_ORDERS, { 1: { rows: [{ purchaseNum: "PO1" }] } });
      await collect(
        query({
          table: PURCHASE_ORDERS.name,
          fields: ["purchaseNum"],
          and: [{ field: "statusID", op: "eq", value: 3 }],
        }),
      );
      expect(lastPushed(calls)).toEqual(kept ? { statusID: "3" } : {});
    }
  });

  test("drops a param the endpoint ignores, warns, and stops pushing it", async () => {
    const calls = mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const entity = objectForPath(url.pathname)!;
      if (entity.mode === "direct") return envelope([]);
      if (entity !== PURCHASE_ORDERS) return page([], "", 1, 1);
      // this tenant's endpoint reads branchIDs and ignores statusID
      const ignored = url.searchParams.has("statusID");
      const count = isNegativeControl({ url }) && !ignored ? 0 : 12;
      return envelope({ page: 1, limit: 1, count, data: [], next: "" });
    });
    const connector = new EsbCoreConnector();
    const answer = await connector.discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(answer.warnings).toEqual([
      "ESB Core purchase_orders (/purchase/purchase-order) ignores the statusID filter; Atlas filters statusID itself",
    ]);

    calls.length = 0;
    const rows = [{ purchaseNum: "PO1", statusID: 1 }];
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      calls.push({ url });
      return page(rows, "", Number(url.searchParams.get("page")));
    });
    await collect(
      query({
        table: PURCHASE_ORDERS.name,
        fields: ["purchaseNum"],
        and: [
          { field: "statusID", op: "eq", value: 3 },
          { field: "branchID", op: "eq", value: 2 },
        ],
        limit: 1,
      }),
    );
    // the dropped param is not sent; the surviving one still narrows
    expect(pushed(calls[0]!)).toEqual({ branchIDs: "2" });
  });
});

describe("ESB Core discovery failures", () => {
  test("omits entities whose rows contradict their catalog schema", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const entity = objectForPath(url.pathname)!;
      if (entity === PRODUCTS) return page([{ productID: 1, productName: { malformed: true } }], "", 1, 1);
      return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    const answer = await new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(answer.tables).toHaveLength(38);
    expect(answer.tables.some((table) => table.name === PRODUCTS.name)).toBe(false);
    expect(answer.warnings).toEqual([
      `ESB Core products (${PRODUCTS.path}) was omitted: response format is not supported by Atlas`,
    ]);
  });

  test("omits an all-nullable entity whose response contains no catalog fields", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const entity = objectForPath(url.pathname)!;
      if (entity === GOODS_DELIVERIES) return page([{ unexpected: { junk: true } }], "", 1, 1);
      return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });

    const answer = await new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(answer.tables).toHaveLength(38);
    expect(answer.tables.some((table) => table.name === GOODS_DELIVERIES.name)).toBe(false);
    expect(answer.warnings).toEqual([
      `ESB Core goods_deliveries (${GOODS_DELIVERIES.path}) was omitted: response format is not supported by Atlas`,
    ]);
  });

  test("omits endpoint-local permission and incompatible entities with warnings", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const entity = objectForPath(url.pathname)!;
      if (entity === PRODUCTS) return failure("EC03100001", 403, "Unauthorized to access products");
      if (entity.name === "suppliers") return envelope({ page: 1, limit: 1, data: "bad", next: "" });
      return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    const answer = await new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(answer.tables).toHaveLength(37);
    expect(answer.tables.some((table) => table.name === PRODUCTS.name)).toBe(false);
    expect(answer.tables.some((table) => table.name === "suppliers")).toBe(false);
    expect(answer.warnings).toHaveLength(2);
  });

  test("omits a known permission denial carried in a successful HTTP envelope", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const entity = objectForPath(url.pathname)!;
      if (entity === PRODUCTS) return failure("EC03100001", 200, "Unauthorized to access products");
      return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    const answer = await new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(answer.tables).toHaveLength(38);
    expect(answer.tables.some((table) => table.name === PRODUCTS.name)).toBe(false);
    expect(answer.warnings).toHaveLength(1);
  });

  test("omits every documented permission denial carried in a successful HTTP envelope", async () => {
    const denials = [
      ["EC03100003", "access denied. the user does not have permission to view goods receipt data"],
      ["EC03100003", "access denied. the user does not have permission to view goods transfer request data"],
      ["EC03100003", "access denied: the user does not have permission to view purchase request data"],
      [
        "EC03100003",
        "access denied: user does not have mapping access to view purchase request from branches: '[ESB Cabang Poris]' (branchID: 3)",
      ],
      ["EC03100002", "you did not have access to this resource"],
      ["EC03100001", "unauthorized to access index Material Delivery"],
    ] as const;

    for (const [code, message] of denials) {
      resetEsbCoreTokenCacheForTests();
      mockFetch(({ url }) => {
        if (url.pathname.endsWith("/auth/login")) return token();
        const entity = objectForPath(url.pathname)!;
        if (entity === PRODUCTS) return failure(code, 200, message);
        return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
      });
      const answer = await new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 });
      expect(answer.tables).toHaveLength(38);
      expect(answer.warnings).toHaveLength(1);
    }
  });

  test("keeps EC03100003 validation failures fatal", async () => {
    for (const message of ["Validation Error", 'strconv.ParseInt: parsing "a": invalid syntax']) {
      resetEsbCoreTokenCacheForTests();
      mockFetch(({ url }) => {
        if (url.pathname.endsWith("/auth/login")) return token();
        const entity = objectForPath(url.pathname)!;
        if (entity === PRODUCTS) return failure("EC03100003", 200, message);
        return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
      });
      await expect(
        new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({ code: "EC03100003", applicationFailure: true });
    }
  });

  test("keeps valid application codes fatal when another envelope field is malformed", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const entity = objectForPath(url.pathname)!;
      if (entity === PRODUCTS) {
        return Response.json(
          { status: "fail", code: "EC03199999", message: null, result: null },
          { status: 400 },
        );
      }
      return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    await expect(
      new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "EC03199999", applicationFailure: true });
  });

  test("fails when no collection endpoint is readable", async () => {
    mockFetch(({ url }) =>
      url.pathname.endsWith("/auth/login")
        ? token()
        : failure("EC03100001", 403, `Unauthorized to access ${url.pathname}`),
    );
    await expect(
      new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 }),
    ).rejects.toThrow(/no readable collection endpoints/);
  });

  test("does not hide authentication or transient failures", async () => {
    mockFetch(({ url }) =>
      url.pathname.endsWith("/auth/login")
        ? failure("EC03100032", 401, "Invalid credentials")
        : page([], "", 1, 1),
    );
    await expect(
      new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "EC03100032", credentialFailure: true });

    resetEsbCoreTokenCacheForTests();
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const entity = objectForPath(url.pathname)!;
      if (entity === PRODUCTS) return failure("EC03500000", 503, "Unavailable");
      return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    await expect(
      new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "EC03500000", status: 503 });
  });

  test("keeps unknown application failures fatal at every HTTP status", async () => {
    for (const status of [200, 400, 403]) {
      resetEsbCoreTokenCacheForTests();
      mockFetch(({ url }) => {
        if (url.pathname.endsWith("/auth/login")) return token();
        const entity = objectForPath(url.pathname)!;
        if (entity === PRODUCTS) return failure("EC03199999", status, "Unknown");
        return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
      });
      await expect(
        new EsbCoreConnector().discovery({ credentials: CREDENTIALS, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({
        code: "EC03199999",
        status,
        applicationFailure: true,
      });
    }
  });
});

describe("ESB Core pushdown", () => {
  test("sends eq, in and a date window as the params the catalog maps them to", async () => {
    const calls = mockObjectRows(PURCHASE_ORDERS, { 1: { rows: [{ purchaseNum: "PO1" }] } });
    await collect(
      query({
        table: PURCHASE_ORDERS.name,
        fields: ["purchaseNum"],
        and: [
          { field: "branchID", op: "in", values: [1, 2] },
          { field: "supplierID", op: "eq", value: 463 },
          { field: "statusID", op: "eq", value: 3 },
          { field: "purchaseDate", op: "gte", value: "2026-08-01T00:00:00" },
          { field: "purchaseDate", op: "lte", value: "2026-08-31T23:59:59" },
        ],
      }),
    );
    expect(lastPushed(calls)).toEqual({
      branchIDs: "1,2",
      supplierIDs: "463",
      statusID: "3",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
    });
  });

  test("an eq on a date field becomes the one-day window", async () => {
    const calls = mockObjectRows(GOODS_RECEIPTS, { 1: { rows: [{ goodsReceiptNum: "GR1" }] } });
    await collect(
      query({
        table: GOODS_RECEIPTS.name,
        fields: ["goodsReceiptNum"],
        and: [{ field: "goodsReceiptDate", op: "eq", value: "2026-09-08" }],
        limit: 2,
      }),
    );
    expect(lastPushed(calls)).toEqual({ dateFrom: "2026-09-08", dateTo: "2026-09-08" });
    expect(calls.at(-1)?.url.searchParams.get("limit")).toBe("2");
  });

  // ESB matches nothing on a half-open range
  test("a one-sided date bound rides with the opposite end wide open", async () => {
    const calls = mockObjectRows(GOODS_RECEIPTS, { 1: { rows: [{ goodsReceiptNum: "GR1" }] } });
    await collect(
      query({
        table: GOODS_RECEIPTS.name,
        fields: ["goodsReceiptNum"],
        and: [{ field: "goodsReceiptDate", op: "gte", value: "2026-09-01" }],
        limit: 2,
      }),
    );
    expect(lastPushed(calls)).toEqual({ dateFrom: "2026-09-01", dateTo: "2100-12-31" });

    resetEsbCoreTokenCacheForTests();
    const closing = mockObjectRows(GOODS_RECEIPTS, { 1: { rows: [{ goodsReceiptNum: "GR1" }] } });
    await collect(
      query({
        table: GOODS_RECEIPTS.name,
        fields: ["goodsReceiptNum"],
        and: [{ field: "goodsReceiptDate", op: "lte", value: "2026-09-30" }],
        limit: 2,
      }),
    );
    expect(lastPushed(closing)).toEqual({ dateFrom: "1900-01-01", dateTo: "2026-09-30" });
  });

  // gt and lt are exclusive and the params are not, so neither is sent
  test("an exclusive date bound is the host's, and leaves the rows a superset", async () => {
    const calls = mockObjectRows(GOODS_RECEIPTS, { 1: { rows: [{ goodsReceiptNum: "GR1" }] } });
    const answered = await run(
      query({
        table: GOODS_RECEIPTS.name,
        fields: ["goodsReceiptNum"],
        and: [
          { field: "goodsReceiptDate", op: "gte", value: "2026-09-01" },
          { field: "goodsReceiptDate", op: "lt", value: "2026-09-30" },
        ],
        limit: 2,
      }),
    );
    expect(lastPushed(calls)).toEqual({ dateFrom: "2026-09-01", dateTo: "2100-12-31" });
    expect(answered.served).toEqual({ filters: false, sort: true, window: false });
  });

  test("a filter the map cannot spell is left to the host, and the rows stay a superset", async () => {
    const rows = [
      { productID: 1, productName: "One", categoryID: 5 },
      { productID: 2, productName: "Two", categoryID: 10 },
      { productID: 3, productName: "Three", categoryID: 10 },
    ];
    const calls = mockObjectRows(PRODUCTS, { 1: { rows } });
    const answered = await collect(
      query({
        and: [
          { field: "categoryID", op: "eq", value: 10 },
          { field: "productName", op: "startswith", value: "T" },
        ],
        fields: ["productID"],
        limit: 1,
      }),
    );
    // the pushable half still narrows; the unpushable half rules out the window
    expect(lastPushed(calls)).toEqual({ categoryID: "10" });
    expect(answered).toEqual([{ productID: 1 }, { productID: 2 }, { productID: 3 }]);
  });

  test("a substring param narrows but never counts as served", async () => {
    const rows = [{ purchaseNum: "PO2026" }, { purchaseNum: "PO202601" }];
    const calls = mockObjectRows(PURCHASE_ORDERS, { 1: { rows } });
    const answered = await collect(
      query({
        table: PURCHASE_ORDERS.name,
        fields: ["purchaseNum"],
        and: [{ field: "purchaseNum", op: "eq", value: "PO2026" }],
        limit: 1,
      }),
    );
    expect(lastPushed(calls)).toEqual({ purchaseNum: "PO2026" });
    expect(answered).toHaveLength(2);
  });

  test("an in-set with a null member has no comma-separated spelling", async () => {
    const calls = mockObjectRows(PURCHASE_ORDERS, { 1: { rows: [{ purchaseNum: "PO1" }] } });
    await collect(
      query({
        table: PURCHASE_ORDERS.name,
        fields: ["purchaseNum"],
        and: [{ field: "branchID", op: "in", values: [1, null] }],
        limit: 1,
      }),
    );
    expect(lastPushed(calls)).toEqual({});
  });

  test("an or-group has no upstream spelling, so nothing is pushed", async () => {
    const calls = mockObjectRows(PURCHASE_ORDERS, { 1: { rows: [{ purchaseNum: "PO1" }] } });
    await collect(
      query({
        table: PURCHASE_ORDERS.name,
        fields: ["purchaseNum"],
        and: [],
        or: [[{ field: "statusID", op: "eq", value: 3 }]],
        limit: 1,
      }),
    );
    expect(lastPushed(calls)).toEqual({});
  });

  test("a second filter on one field would narrow past the request, so it stays home", async () => {
    const calls = mockObjectRows(PURCHASE_ORDERS, { 1: { rows: [{ purchaseNum: "PO1" }] } });
    await collect(
      query({
        table: PURCHASE_ORDERS.name,
        fields: ["purchaseNum"],
        and: [
          { field: "statusID", op: "eq", value: 3 },
          { field: "statusID", op: "eq", value: 1 },
        ],
      }),
    );
    expect(lastPushed(calls)).toEqual({ statusID: "3" });
  });

  test("a top-N on a sortable column is one page of exactly the rows asked for", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ purchaseNum: `PO${index}` }));
    const calls = mockObjectRows(PURCHASE_ORDERS, { 1: { rows, next: "next" } });
    const answered = await collect(
      query({
        table: PURCHASE_ORDERS.name,
        fields: ["purchaseNum"],
        sort: [{ field: "purchaseNum", dir: "desc" }],
        limit: 5,
      }),
    );
    expect(answered).toHaveLength(5);
    const collection = collectionCalls(calls, PURCHASE_ORDERS);
    expect(collection).toHaveLength(1);
    expect(collection[0]?.url.searchParams.get("limit")).toBe("5");
    expect(pushed(collection[0]!)).toEqual({ sort: "-purchaseNum" });
  });

  test("ascending on a nullable column is the host's, because ESB orders its nulls first", async () => {
    const calls = mockObjectRows(GOODS_RECEIPTS, { 1: { rows: [{ goodsReceiptNum: "GR1" }] } });
    await collect(
      query({
        table: GOODS_RECEIPTS.name,
        fields: ["goodsReceiptNum"],
        sort: [{ field: "goodsReceiptDate", dir: "asc" }],
        limit: 1,
      }),
    );
    expect(lastPushed(calls)).toEqual({});

    resetEsbCoreTokenCacheForTests();
    const descending = mockObjectRows(GOODS_RECEIPTS, { 1: { rows: [{ goodsReceiptNum: "GR1" }] } });
    await collect(
      query({
        table: GOODS_RECEIPTS.name,
        fields: ["goodsReceiptNum"],
        sort: [{ field: "goodsReceiptDate", dir: "desc" }],
        limit: 1,
      }),
    );
    expect(lastPushed(descending)).toEqual({ sort: "-goodsReceiptDate" });
  });

  test("a column ESB will not order by, and a second sort key, both stay home", async () => {
    for (const sort of [
      [{ field: "supplierID", dir: "desc" as const }],
      [
        { field: "purchaseNum", dir: "desc" as const },
        { field: "statusID", dir: "asc" as const },
      ],
    ]) {
      resetEsbCoreTokenCacheForTests();
      const calls = mockObjectRows(PURCHASE_ORDERS, { 1: { rows: [{ purchaseNum: "PO1" }] } });
      await collect(query({ table: PURCHASE_ORDERS.name, fields: ["purchaseNum"], sort, limit: 1 }));
      expect(lastPushed(calls)).toEqual({});
      expect(PURCHASE_ORDERS.sortFields).not.toContain("supplierID");
    }
  });

  test("the stream's leading plan says which of the filter, the order and the window ESB served", async () => {
    const receipt = { goodsReceiptNum: "GR1" };
    const plans = async (overrides: Partial<NativeQueryRequest>): Promise<Served | undefined> => {
      resetEsbCoreTokenCacheForTests();
      mockObjectRows(GOODS_RECEIPTS, { 1: { rows: [receipt] } });
      const answered = await run(
        query({ table: GOODS_RECEIPTS.name, fields: ["goodsReceiptNum"], limit: 5, ...overrides }),
      );
      return answered.served;
    };

    expect(
      await plans({
        and: [{ field: "branchID", op: "eq", value: 1 }],
        sort: [{ field: "goodsReceiptDate", dir: "desc" }],
      }),
    ).toEqual({ filters: true, sort: true, window: true });

    // additionalInfo is not a column ESB orders by, so order and window are the host's
    expect(
      await plans({
        and: [{ field: "branchID", op: "eq", value: 1 }],
        sort: [{ field: "additionalInfo", dir: "desc" }],
      }),
    ).toEqual({ filters: true, sort: false, window: false });

    expect(await plans({ and: [{ field: "refNum", op: "eq", value: "R1" }] })).toEqual({
      filters: false,
      sort: true,
      window: false,
    });
  });
});

describe("ESB Core query", () => {
  test("projects requested fields and honors a limit the upstream served", async () => {
    mockObjectRows(SIMPLE_MANUFACTURING, {
      1: {
        rows: [
          { simpleManufacturingNum: "SM1", branchID: 4, statusID: 3 },
          { simpleManufacturingNum: "SM2", branchID: 4, statusID: 3 },
        ],
      },
    });
    expect(
      await collect(
        query({
          table: SIMPLE_MANUFACTURING.name,
          and: [{ field: "branchID", op: "eq", value: 4 }],
          fields: ["simpleManufacturingNum"],
          limit: 1,
        }),
      ),
    ).toEqual([{ simpleManufacturingNum: "SM1" }]);
  });

  test("rejects unknown tables, requested/filter/sort fields, and joins", async () => {
    const invalid: Array<[NativeQueryRequest, number]> = [
      [query({ table: "missing" }), 404],
      [query({ fields: ["missing"] }), 422],
      [query({ and: [{ field: "missing", op: "eq", value: 1 }] }), 422],
      [query({ sort: [{ field: "missing", dir: "asc" }] }), 422],
      [
        query({
          joins: [
            {
              fromTable: "products",
              toTable: "products",
              fromField: "productID",
              toField: "productID",
              fields: [],
            },
          ],
        }),
        422,
      ],
    ];
    for (const [request, status] of invalid) await expect(collect(request)).rejects.toMatchObject({ status });
  });

  test("normalizes documented boolean flags without validating unrequested fields", async () => {
    mockObjectRows(CUSTOMERS, {
      1: {
        rows: [{ customerID: 1, customerName: { malformed: true }, flagActive: 1, lockVat: 0 }],
      },
    });
    expect(
      await collect(
        query({
          table: CUSTOMERS.name,
          fields: ["customerID", "flagActive", "lockVat"],
        }),
      ),
    ).toEqual([{ customerID: 1, flagActive: true, lockVat: false }]);
  });

  test("reads direct endpoints once and follows next across empty paged responses", async () => {
    const directCalls = mockObjectRows(BRANCHES, { 1: { rows: [{ branchID: 1, branchName: "Main" }] } });
    expect(await collect(query({ table: BRANCHES.name, fields: ["branchName"] }))).toEqual([{ branchName: "Main" }]);
    expect(collectionCalls(directCalls, BRANCHES)).toHaveLength(1);

    resetEsbCoreTokenCacheForTests();
    const pagedCalls = mockObjectRows(PRODUCTS, {
      1: { rows: [], next: "next" },
      2: { rows: [{ productID: 2, productName: "Second" }] },
    });
    expect(await collect(query())).toEqual([{ productID: 2, productName: "Second" }]);
    expect(pagedCalls.at(-1)?.url.searchParams.get("page")).toBe("2");
  });

  test("terminates a paged response when next is omitted", async () => {
    const calls = mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      expect(url.pathname).toBe(`/core${PRODUCTS.path}`);
      return envelope({ page: 1, limit: 100, data: [{ productID: 1, productName: "First" }] });
    });

    expect(await collect(query())).toEqual([{ productID: 1, productName: "First" }]);
    expect(collectionCalls(calls, PRODUCTS)).toHaveLength(1);
  });

  test("preserves catalog date values as YYYY-MM-DD and normalizes zoned datetimes", async () => {
    mockObjectRows(RECEIPTS, { 1: { rows: [{ receiptNum: "a", receiptDate: "2024-01-01" }] } });
    expect(await collect(query({ table: RECEIPTS.name, fields: ["receiptNum", "receiptDate"] }))).toEqual([
      { receiptNum: "a", receiptDate: "2024-01-01" },
    ]);

    resetEsbCoreTokenCacheForTests();
    mockObjectRows(ITEM_JOURNALS, {
      1: {
        rows: [
          { itemJournalNum: "a", itemJournalDate: "2024-01-01T09:00:00+07:00" },
          { itemJournalNum: "b", itemJournalDate: "2024-01-01T09:00:00" },
        ],
      },
    });
    expect(await collect(query({ table: ITEM_JOURNALS.name, fields: ["itemJournalNum", "itemJournalDate"] }))).toEqual([
      { itemJournalNum: "a", itemJournalDate: "2024-01-01T02:00:00.000Z" },
      { itemJournalNum: "b", itemJournalDate: "2024-01-01T09:00:00" },
    ]);
  });

  test("rejects missing, structured, and non-finite primary keys", async () => {
    for (const productID of [null, { nested: true }, Number.POSITIVE_INFINITY]) {
      resetEsbCoreTokenCacheForTests();
      mockObjectRows(PRODUCTS, { 1: { rows: [{ productID, productName: "bad" }] } });
      await expect(collect(query())).rejects.toThrow(/productID/);
    }
  });

  test("scans an unfiltered entity that has no primary key", async () => {
    // no primaryKey, so a fieldless scan projects every row to {}
    const rows = [{ goodsDeliveryNum: "GD1" }, { goodsDeliveryNum: "GD2" }, { goodsDeliveryNum: "GD3" }];
    expect(GOODS_DELIVERIES.primaryKey).toBeUndefined();
    mockObjectRows(GOODS_DELIVERIES, { 1: { rows } });
    expect(await collect(query({ table: GOODS_DELIVERIES.name, fields: [] }))).toHaveLength(3);
  });

  test("refuses to truncate a page walk beyond the hard maximum", async () => {
    let resources = 0;
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      resources += 1;
      const pageNumber = Number(url.searchParams.get("page"));
      return page([], "next", pageNumber);
    });
    await expect(collect(query({ timeoutMs: 30_000 }))).rejects.toThrow(/exceeded 20000 pages/);
    expect(resources).toBe(20_000);
  }, 120_000);

  test("chunks oversized direct collections before yielding", async () => {
    const rows = Array.from({ length: CONNECTOR_LIMITS.rowsPerBatch + 1 }, (_, branchID) => ({ branchID }));
    mockObjectRows(BRANCHES, { 1: { rows } });
    const { batches } = await run(query({ table: BRANCHES.name, fields: ["branchID"] }));
    expect(batches.map((batch) => batch.length)).toEqual([CONNECTOR_LIMITS.rowsPerBatch, 1]);
  });

  test("reads each object at its own page size", async () => {
    const productCalls = mockObjectRows(PRODUCTS, { 1: { rows: [{ productID: 1, productName: "One" }] } });
    expect(PRODUCTS.pageSize).toBeUndefined();
    await collect(query());
    expect(productCalls.at(-1)?.url.searchParams.get("limit")).toBe("1000");

    resetEsbCoreTokenCacheForTests();
    const receiptCalls = mockObjectRows(RECEIPTS, { 1: { rows: [{ receiptNum: "R1" }] } });
    expect(RECEIPTS.pageSize).toBe(200);
    expect(await collect(query({ table: RECEIPTS.name, fields: ["receiptNum"] }))).toEqual([{ receiptNum: "R1" }]);
    expect(receiptCalls.at(-1)?.url.searchParams.get("limit")).toBe("200");
  });

  test("jumps straight to the offset's page, and walks from page 1 once the host owns a filter", async () => {
    const fullPages = ({ url }: { url: URL }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const pageNumber = Number(url.searchParams.get("page"));
      const start = (pageNumber - 1) * 1_000;
      const rows = Array.from({ length: 1_000 }, (_, index) => ({ productID: start + index }));
      return page(rows, pageNumber < 3 ? "next" : "", pageNumber, 1_000);
    };
    const requestedPages = (calls: Call[]) =>
      collectionCalls(calls, PRODUCTS).map((call) => call.url.searchParams.get("page"));

    const jumped = mockFetch(fullPages);
    expect(
      (await collect(query({ fields: ["productID"], offset: 2_500, limit: 3 }))).map((row) => row.productID),
    ).toEqual([2_500, 2_501, 2_502]);
    expect(requestedPages(jumped)).toEqual(["3"]);

    resetEsbCoreTokenCacheForTests();
    const walked = mockFetch(fullPages);
    expect(
      await collect(
        query({
          fields: ["productID"],
          and: [{ field: "productID", op: "gte", value: 0 }],
          offset: 2_500,
          limit: 1,
        }),
      ),
    ).toHaveLength(3_000);
    expect(requestedPages(walked)).toEqual(["1", "2", "3"]);
  });

  test("reads /units as the paged collection the server answers with", async () => {
    expect(UNITS.mode).toBe("paged");
    mockObjectRows(UNITS, { 1: { rows: [{ uomID: 1, uomName: "kg" }] } });
    expect(await collect(query({ table: UNITS.name, fields: ["uomName"] }))).toEqual([{ uomName: "kg" }]);
  });

  test("keeps goods rows whose number is not assigned until authorisation", async () => {
    expect(GOODS_RECEIPTS.primaryKey).toBeUndefined();
    for (const entity of [GOODS_RECEIPTS, GOODS_DELIVERIES]) {
      const number = entity.columns[0]!;
      expect([number.nullable, number.unique]).toEqual([true, false]);
    }
    mockObjectRows(GOODS_RECEIPTS, { 1: { rows: [{ goodsReceiptNum: null, statusName: "Pending" }] } });
    expect(
      await collect(query({ table: GOODS_RECEIPTS.name, fields: ["goodsReceiptNum", "statusName"] })),
    ).toEqual([{ goodsReceiptNum: null, statusName: "Pending" }]);
  });

  test("ends the walk on a null data page and reads a null result as no rows", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      if (url.pathname !== `/core${PRODUCTS.path}`) return envelope(null);
      const pageNumber = Number(url.searchParams.get("page"));
      const rows = pageNumber === 1 ? [{ productID: 1, productName: "One" }] : null;
      return envelope({ page: pageNumber, limit: 1_000, count: 1, data: rows, next: rows ? "next" : "" });
    });
    expect(await collect(query())).toEqual([{ productID: 1, productName: "One" }]);
    expect(await collect(query({ table: COST_CENTERS.name, fields: ["costCenterName"] }))).toEqual([]);
  });
});

describe("ESB Core count and size", () => {
  const request = { credentials: CREDENTIALS, timeoutMs: 1_000 };

  test("counts the filtered collection in one request", async () => {
    const calls = mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const branch = url.searchParams.get("branchIDs");
      return envelope({ page: 1, limit: 1, count: branch === "1" ? 197 : 9_639, data: [], next: "next" });
    });
    const counted = await new EsbCoreConnector().count({
      table: PURCHASE_ORDERS.name,
      and: [{ field: "branchID", op: "eq", value: 1 }],
      ...request,
    });
    expect(counted).toBe(197);
    const collection = collectionCalls(calls, PURCHASE_ORDERS);
    expect(collection).toHaveLength(1);
    expect(collection[0]?.url.searchParams.get("limit")).toBe("1");
  });

  test("declines a filter it cannot push, so the host tallies /query instead", async () => {
    mockObjectRows(PURCHASE_ORDERS, { 1: { rows: [] } });
    const connector = new EsbCoreConnector();
    for (const and of [
      [{ field: "supplierName", op: "eq" as const, value: "Acme" }],
      [{ field: "purchaseNum", op: "eq" as const, value: "PO1" }],
    ]) {
      await expect(connector.count({ table: PURCHASE_ORDERS.name, and, ...request })).rejects.toMatchObject({
        status: 422,
      });
    }
  });

  test("counts a direct collection by its rows, and declines to filter one", async () => {
    mockObjectRows(BRANCHES, { 1: { rows: [{ branchID: 1 }, { branchID: 2 }] } });
    const connector = new EsbCoreConnector();
    expect(await connector.count({ table: BRANCHES.name, and: [], ...request })).toBe(2);
    await expect(
      connector.count({
        table: BRANCHES.name,
        and: [{ field: "branchID", op: "eq", value: 1 }],
        ...request,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  test("size reads the paged total in one unfiltered request and counts a direct array", async () => {
    const calls = mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      if (url.pathname === `/core${PRODUCTS.path}`) {
        return envelope({ page: 1, limit: 1, count: 62, data: [{ productID: 1 }], next: "next" });
      }
      return envelope([{ branchID: 1 }, { branchID: 2 }]);
    });
    const connector = new EsbCoreConnector();

    expect(await connector.size({ table: PRODUCTS.name, ...request })).toEqual({ rows: 62, exact: true });
    const productCalls = collectionCalls(calls, PRODUCTS);
    expect(productCalls).toHaveLength(1);
    expect(productCalls[0]?.url.searchParams.get("limit")).toBe("1");
    expect(pushed(productCalls[0]!)).toEqual({});
    expect(await connector.size({ table: BRANCHES.name, ...request })).toEqual({ rows: 2, exact: true });
  });

  test("size answers null when a paged response carries no count", async () => {
    mockObjectRows(PRODUCTS, { 1: { rows: [{ productID: 1 }, { productID: 2 }] } });
    expect(await new EsbCoreConnector().size({ table: PRODUCTS.name, ...request })).toBeNull();
  });
});

describe("ESB Core HTTP boundary", () => {
  const app = createApp(new EsbCoreConnector(), { token: TOKEN });
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  function post(path: string, body: unknown): Promise<Response> {
    return app.handle(
      new Request(`http://connector.test${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  }

  test("serves the capability with the endpoints its own methods back", async () => {
    const capability = await app.handle(new Request("http://connector.test/.well-known/futurity/atlas.json"));
    expect(await capability.json()).toEqual({ ...CAPABILITY, endpoints: ["size", "count"] });
  });

  test("exposes sanitized check failures", async () => {
    mockFetch(() => failure("EC03100032", 401, `bad ${CREDENTIALS.password}`));
    const response = await post("/check", { credentials: CREDENTIALS, timeoutMs: 1_000 });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("check_failed");
    expect(body.error.message).not.toContain(CREDENTIALS.password);
  });

  test("answers discovery through the protocol runtime", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const entity = objectForPath(url.pathname)!;
      return entity.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    const response = await post("/discovery", { credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tables: Array<{ name: string }> };
    expect(body.tables.map((table) => table.name)).toEqual(ESB_CORE_CATALOG.map((entry) => entry.name));
  });

  test("streams query as ndjson", async () => {
    mockObjectRows(PRODUCTS, { 1: { rows: [{ productID: 2, productName: "Two" }] } });
    const stream = await post("/query", { ...query(), idleTimeoutMs: 1_000, maxTimeoutMs: 2_000 });
    expect(stream.status).toBe(200);
    const lines = (await stream.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { served: { filters: true, sort: true, window: true } },
      { rows: [{ productID: 2, productName: "Two" }] },
      { end: 1 },
    ]);
  });

  test("keeps unknown entities as a typed 404 envelope", async () => {
    const stream = await post("/query", { ...query({ table: "missing" }), idleTimeoutMs: 1_000, maxTimeoutMs: 2_000 });
    const lines = (await stream.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([{ error: { code: "unknown_entity", message: 'unknown table "missing"' } }]);
  });
});
