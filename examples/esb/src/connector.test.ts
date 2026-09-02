import { afterEach, describe, expect, test } from "bun:test";
import {
  CONNECTOR_LIMITS,
  createApp,
  OPS,
  type NativeQueryRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { ATLAS_JSON } from "./capability";
import { ESB_CORE_CATALOG, validateEsbCoreCatalog } from "./catalog";
import { EsbCoreConnector } from "./connector";
import { resetEsbCoreTokenCacheForTests } from "./esb-api";
import type { EsbCoreObject } from "./types";

const TOKEN = "0123456789abcdef0123456789abcdef";
const CREDENTIALS = { username: "atlas-reader", password: "private-password" };
const PRODUCTS = ESB_CORE_CATALOG.find((object) => object.name === "products")!;
const BRANCHES = ESB_CORE_CATALOG.find((object) => object.name === "branches")!;
const ADVANCE_PAYMENTS = ESB_CORE_CATALOG.find((object) => object.name === "advance_payments")!;
const ITEM_JOURNALS = ESB_CORE_CATALOG.find((object) => object.name === "item_journals")!;
const PRICELISTS = ESB_CORE_CATALOG.find((object) => object.name === "pricelists")!;
const RECEIPTS = ESB_CORE_CATALOG.find((object) => object.name === "receipts")!;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEsbCoreTokenCacheForTests();
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
  return ESB_CORE_CATALOG.find((object) => pathname === `/core${object.path}`);
}

function page(rows: Record<string, unknown>[], next = "", pageNumber = 1, limit = 100): Response {
  return envelope({ page: pageNumber, limit, data: rows, next });
}

function mockObjectRows(object: EsbCoreObject, pages: Record<number, { rows: Record<string, unknown>[]; next?: string }>): Call[] {
  return mockFetch(({ url }) => {
    if (url.pathname.endsWith("/auth/login")) return token();
    expect(url.pathname).toBe(`/core${object.path}`);
    if (object.mode === "direct") return envelope(pages[1]?.rows ?? []);
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

async function collect(request: NativeQueryRequest): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for await (const batch of new EsbCoreConnector().query(request)) rows.push(...batch);
  return rows;
}

describe("ESB Core capability and catalog", () => {
  test("advertises exactly the behavior and credentials the connector implements", () => {
    expect(new EsbCoreConnector().slug).toBe("esb-core");
    expect(ATLAS_JSON.slug).toBe("esb-core");
    expect(ATLAS_JSON.capabilities).toMatchObject({
      sort: "multi",
      offset: true,
      count: "scan",
      join: false,
      enforcesDeclaredKeys: false,
      probeConcurrency: 4,
      cheapProbes: false,
    });
    expect(ATLAS_JSON.capabilities.operators).toEqual(OPS.filter((op) => op !== "contains"));
    expect(ATLAS_JSON.credentialSchema.map((field) => [field.key, field.type, field.required])).toEqual([
      ["username", "text", true],
      ["password", "password", true],
    ]);
    expect(ATLAS_JSON.endpoints).toEqual([]);
  });

  test("contains 39 unique entities with valid unique fields and primary keys", () => {
    expect(ESB_CORE_CATALOG).toHaveLength(39);
    expect(new Set(ESB_CORE_CATALOG.map((object) => object.name)).size).toBe(39);
    expect(ESB_CORE_CATALOG.filter((object) => object.mode === "direct")).toHaveLength(4);
    expect(() => validateEsbCoreCatalog()).not.toThrow();
    for (const object of ESB_CORE_CATALOG) {
      expect(new Set(object.columns.map((column) => column.name)).size).toBe(object.columns.length);
      if (object.primaryKey) expect(object.columns.some((column) => column.name === object.primaryKey)).toBe(true);
    }
  });

  test("uses plain descriptions and advertises documented date-only fields as dates", () => {
    const parentheticalDescriptions = ESB_CORE_CATALOG.flatMap((object) =>
      object.columns
        .filter((column) => /[()]/.test(column.description))
        .map((column) => `${object.name}.${column.name}`),
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

  test("catalog validation rejects duplicate tables, duplicate fields, and undeclared keys", () => {
    const base: EsbCoreObject = {
      name: "one",
      path: "/one",
      description: "One",
      mode: "paged",
      primaryKey: "id",
      columns: [{ name: "id", type: "number", nullable: false, description: "ID" }],
    };
    expect(() => validateEsbCoreCatalog([base, { ...base }])).toThrow(/duplicate ESB Core table/);
    expect(() => validateEsbCoreCatalog([{ ...base, columns: [base.columns[0]!, base.columns[0]!] }])).toThrow(
      /duplicate ESB Core field/,
    );
    expect(() => validateEsbCoreCatalog([{ ...base, primaryKey: "missing" }])).toThrow(/not a declared field/);
  });
});

describe("ESB Core discovery", () => {
  test("maps every accessible catalog entity in catalog order", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const object = objectForPath(url.pathname);
      if (!object) throw new Error(`unexpected path ${url.pathname}`);
      return object.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    const answer = await new EsbCoreConnector().discover({ credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(answer.tables.map((table) => table.name)).toEqual(ESB_CORE_CATALOG.map((object) => object.name));
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

  test("omits endpoint-local permission and incompatible entities with warnings", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const object = objectForPath(url.pathname)!;
      if (object === PRODUCTS) return failure("EC03100001", 403, "Unauthorized to access products");
      if (object.name === "suppliers") return envelope({ page: 1, limit: 1, data: "bad", next: "" });
      return object.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    const answer = await new EsbCoreConnector().discover({ credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(answer.tables).toHaveLength(37);
    expect(answer.tables.some((table) => table.name === PRODUCTS.name)).toBe(false);
    expect(answer.tables.some((table) => table.name === "suppliers")).toBe(false);
    expect(answer.warnings).toHaveLength(2);
  });

  test("omits a known permission denial carried in a successful HTTP envelope", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const object = objectForPath(url.pathname)!;
      if (object === PRODUCTS) return failure("EC03100001", 200, "Unauthorized to access products");
      return object.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    const answer = await new EsbCoreConnector().discover({ credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(answer.tables).toHaveLength(38);
    expect(answer.tables.some((table) => table.name === PRODUCTS.name)).toBe(false);
    expect(answer.warnings).toHaveLength(1);
  });

  test("fails when no collection endpoint is readable", async () => {
    mockFetch(({ url }) =>
      url.pathname.endsWith("/auth/login")
        ? token()
        : failure("EC03100001", 403, `Unauthorized to access ${url.pathname}`),
    );
    await expect(
      new EsbCoreConnector().discover({ credentials: CREDENTIALS, timeoutMs: 5_000 }),
    ).rejects.toThrow(/no readable collection endpoints/);
  });

  test("does not hide authentication or transient failures", async () => {
    mockFetch(({ url }) =>
      url.pathname.endsWith("/auth/login")
        ? failure("EC03100032", 401, "Invalid credentials")
        : page([], "", 1, 1),
    );
    await expect(
      new EsbCoreConnector().discover({ credentials: CREDENTIALS, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "EC03100032", credentialFailure: true });

    resetEsbCoreTokenCacheForTests();
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const object = objectForPath(url.pathname)!;
      if (object === PRODUCTS) return failure("EC03500000", 503, "Unavailable");
      return object.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    await expect(
      new EsbCoreConnector().discover({ credentials: CREDENTIALS, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "EC03500000", status: 503 });
  });

  test("keeps unknown application failures fatal at every HTTP status", async () => {
    for (const status of [200, 400, 403]) {
      resetEsbCoreTokenCacheForTests();
      mockFetch(({ url }) => {
        if (url.pathname.endsWith("/auth/login")) return token();
        const object = objectForPath(url.pathname)!;
        if (object === PRODUCTS) return failure("EC03199999", status, "Unknown");
        return object.mode === "direct" ? envelope([]) : page([], "", 1, 1);
      });
      await expect(
        new EsbCoreConnector().discover({ credentials: CREDENTIALS, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({
        code: "EC03199999",
        status,
        applicationFailure: true,
      });
    }
  });
});

describe("ESB Core query and count", () => {
  test("filters with catalog types, projects requested fields, and honors a limit", async () => {
    mockObjectRows(PRODUCTS, {
      1: {
        rows: [
          { productID: 1, productName: "One", categoryID: 5 },
          { productID: 2, productName: "Two", categoryID: 10 },
          { productID: 3, productName: "Three", categoryID: 15 },
        ],
      },
    });
    const rows = await collect(
      query({
        and: [{ field: "categoryID", op: "gte", value: "10" }],
        fields: ["productName"],
        limit: 1,
        fieldTypes: { categoryID: "string" },
      }),
    );
    expect(rows).toEqual([{ productName: "Two" }]);
  });

  test("rejects unknown tables, requested/filter/sort fields, and joins", async () => {
    const invalid = [
      query({ table: "missing" }),
      query({ fields: ["missing"] }),
      query({ and: [{ field: "missing", op: "eq", value: 1 }] }),
      query({ sort: [{ field: "missing", dir: "asc" }] }),
      query({ joins: [{ fromTable: "products", toTable: "products", fromField: "productID", toField: "productID", fields: [] }] }),
    ];
    for (const request of invalid) await expect(collect(request)).rejects.toMatchObject({ status: expect.any(Number) });
  });

  test("sorts multiple columns digit-exact with nulls last, then applies offset", async () => {
    mockObjectRows(ADVANCE_PAYMENTS, {
      1: {
        rows: [
          { advancePaymentNum: "a", paymentTotal: "9007199254740992", supplierName: "Z" },
          { advancePaymentNum: "b", paymentTotal: "9007199254740993", supplierName: "B" },
          { advancePaymentNum: "c", paymentTotal: "9007199254740993", supplierName: "A" },
          { advancePaymentNum: "d", paymentTotal: null, supplierName: "N" },
        ],
      },
    });
    const rows = await collect(
      query({
        table: ADVANCE_PAYMENTS.name,
        fields: ["advancePaymentNum", "paymentTotal", "supplierName"],
        sort: [
          { field: "paymentTotal", dir: "desc" },
          { field: "supplierName", dir: "asc" },
        ],
        offset: 1,
      }),
    );
    expect(rows.map((row) => row.advancePaymentNum)).toEqual(["b", "a", "d"]);
  });

  test("reads direct endpoints once and follows next across empty paged responses", async () => {
    const directCalls = mockObjectRows(BRANCHES, { 1: { rows: [{ branchID: 1, branchName: "Main" }] } });
    expect(await collect(query({ table: BRANCHES.name, fields: ["branchName"] }))).toEqual([{ branchName: "Main" }]);
    expect(directCalls.filter((call) => call.url.pathname === `/core${BRANCHES.path}`)).toHaveLength(1);

    resetEsbCoreTokenCacheForTests();
    const pagedCalls = mockObjectRows(PRODUCTS, {
      1: { rows: [], next: "next" },
      2: { rows: [{ productID: 2, productName: "Second" }] },
    });
    expect(await collect(query())).toEqual([{ productID: 2, productName: "Second" }]);
    expect(pagedCalls.at(-1)?.url.searchParams.get("page")).toBe("2");
  });

  test("preserves and filters catalog date values as YYYY-MM-DD", async () => {
    mockObjectRows(PRICELISTS, {
      1: {
        rows: [
          { ID: 1, priceDate: "2024-01-01" },
          { ID: 2, priceDate: "2024-01-02" },
        ],
      },
    });
    expect(
      await collect(
        query({
          table: PRICELISTS.name,
          and: [{ field: "priceDate", op: "eq", value: "2024-01-01" }],
          fields: ["ID", "priceDate"],
        }),
      ),
    ).toEqual([{ ID: 1, priceDate: "2024-01-01" }]);

    resetEsbCoreTokenCacheForTests();
    mockObjectRows(RECEIPTS, {
      1: {
        rows: [
          { receiptNum: "a", receiptDate: "2024-01-01" },
          { receiptNum: "b", receiptDate: "2024-01-03" },
        ],
      },
    });
    expect(
      await collect(
        query({
          table: RECEIPTS.name,
          and: [
            { field: "receiptDate", op: "gte", value: "2024-01-02" },
            { field: "receiptDate", op: "lte", value: "2024-01-03" },
          ],
          fields: ["receiptNum", "receiptDate"],
        }),
      ),
    ).toEqual([{ receiptNum: "b", receiptDate: "2024-01-03" }]);
  });

  test("normalizes explicit-zone datetimes and preserves zone-less text", async () => {
    mockObjectRows(ITEM_JOURNALS, {
      1: {
        rows: [
          { itemJournalNum: "a", itemJournalDate: "2024-01-01T09:00:00+07:00" },
          { itemJournalNum: "b", itemJournalDate: "2024-01-01T09:00:00" },
        ],
      },
    });
    const rows = await collect(
      query({ table: ITEM_JOURNALS.name, fields: ["itemJournalNum", "itemJournalDate"] }),
    );
    expect(rows).toEqual([
      { itemJournalNum: "a", itemJournalDate: "2024-01-01T02:00:00.000Z" },
      { itemJournalNum: "b", itemJournalDate: "2024-01-01T09:00:00" },
    ]);
  });

  test("canonicalizes datetime operands in and/or scalar and set filters", async () => {
    mockObjectRows(ITEM_JOURNALS, {
      1: {
        rows: [
          { itemJournalNum: "a", itemJournalDate: "2024-01-01T09:00:00+07:00" },
          { itemJournalNum: "b", itemJournalDate: "2024-01-01T03:00:00Z" },
          { itemJournalNum: "c", itemJournalDate: null },
        ],
      },
    });
    const matchingKeys = async (overrides: Partial<NativeQueryRequest>): Promise<unknown[]> => {
      const rows = await collect(
        query({
          table: ITEM_JOURNALS.name,
          fields: ["itemJournalNum"],
          ...overrides,
        }),
      );
      return rows.map((row) => row.itemJournalNum);
    };

    expect(
      await matchingKeys({ and: [{ field: "itemJournalDate", op: "eq", value: "2024-01-01T02:00:00Z" }] }),
    ).toEqual(["a"]);
    expect(
      await matchingKeys({
        and: [
          { field: "itemJournalDate", op: "gte", value: "2024-01-01T02:00:00+00:00" },
          { field: "itemJournalDate", op: "lte", value: "2024-01-01T09:00:00+07:00" },
        ],
      }),
    ).toEqual(["a"]);
    expect(
      await matchingKeys({
        and: [],
        or: [[{ field: "itemJournalDate", op: "in", values: ["2024-01-01T09:00:00+07:00"] }]],
      }),
    ).toEqual(["a"]);
    expect(
      await matchingKeys({
        and: [{ field: "itemJournalDate", op: "nin", values: ["2024-01-01T02:00:00Z", null] }],
      }),
    ).toEqual(["b", "c"]);
  });

  test("rejects missing, structured, and non-finite primary keys", async () => {
    for (const productID of [null, { nested: true }, Number.POSITIVE_INFINITY]) {
      resetEsbCoreTokenCacheForTests();
      mockObjectRows(PRODUCTS, { 1: { rows: [{ productID, productName: "bad" }] } });
      await expect(collect(query())).rejects.toThrow(/productID/);
    }
  });

  test("count scans the same fully filtered rows as query", async () => {
    const rows = [
      { productID: 1, productName: "Alpha" },
      { productID: 2, productName: "Beta" },
      { productID: 3, productName: "Alpine" },
    ];
    mockObjectRows(PRODUCTS, { 1: { rows } });
    const connector = new EsbCoreConnector();
    const count = await connector.count({
      table: PRODUCTS.name,
      and: [{ field: "productName", op: "startswith", value: "Al" }],
      credentials: CREDENTIALS,
      timeoutMs: 1_000,
    });
    expect(count).toBe(2);
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
  });

  test("chunks oversized direct collections before yielding", async () => {
    const rows = Array.from({ length: CONNECTOR_LIMITS.rowsPerBatch + 1 }, (_, branchID) => ({ branchID }));
    mockObjectRows(BRANCHES, { 1: { rows } });
    const batches: SourceRow[][] = [];
    for await (const batch of new EsbCoreConnector().query(
      query({ table: BRANCHES.name, fields: ["branchID"] }),
    )) {
      batches.push(batch);
    }
    expect(batches.map((batch) => batch.length)).toEqual([CONNECTOR_LIMITS.rowsPerBatch, 1]);
  });

  test("never yields a buffered batch larger than the protocol limit", async () => {
    const rowCount = CONNECTOR_LIMITS.rowsPerBatch + 1;
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token();
      const pageNumber = Number(url.searchParams.get("page"));
      const start = (pageNumber - 1) * 100;
      const rows = Array.from(
        { length: Math.min(100, Math.max(0, rowCount - start)) },
        (_, offset) => ({ productID: start + offset }),
      );
      return page(rows, start + rows.length < rowCount ? "next" : "", pageNumber);
    });
    const batches: SourceRow[][] = [];
    for await (const batch of new EsbCoreConnector().query(query({ sort: [{ field: "productID", dir: "asc" }] }))) {
      batches.push(batch);
    }
    expect(batches.map((batch) => batch.length)).toEqual([CONNECTOR_LIMITS.rowsPerBatch, 1]);
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

  test("serves the capability and exposes sanitized check failures", async () => {
    const capability = await app.handle(new Request("http://connector.test/.well-known/futurity/atlas.json"));
    expect(await capability.json()).toEqual(ATLAS_JSON);
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
      const object = objectForPath(url.pathname)!;
      return object.mode === "direct" ? envelope([]) : page([], "", 1, 1);
    });
    const response = await post("/discovery", { credentials: CREDENTIALS, timeoutMs: 5_000 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tables: Array<{ name: string }> };
    expect(body.tables.map((table) => table.name)).toEqual(ESB_CORE_CATALOG.map((object) => object.name));
  });

  test("answers query and query-stream through the protocol runtime", async () => {
    mockObjectRows(PRODUCTS, { 1: { rows: [{ productID: 1, productName: "One" }] } });
    const response = await post("/query", query());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [{ productID: 1, productName: "One" }] });

    resetEsbCoreTokenCacheForTests();
    mockObjectRows(PRODUCTS, { 1: { rows: [{ productID: 2, productName: "Two" }] } });
    const stream = await post("/query/stream", { ...query(), idleTimeoutMs: 1_000, maxTimeoutMs: 2_000 });
    expect(stream.status).toBe(200);
    const lines = (await stream.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([{ rows: [{ productID: 2, productName: "Two" }] }, { end: 1 }]);
  });

  test("keeps unknown entities as a typed 404 envelope", async () => {
    const response = await post("/query", query({ table: "missing" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "unknown_entity", message: 'unknown table "missing"' },
    });
  });
});
