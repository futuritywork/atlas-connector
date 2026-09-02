import { afterEach, describe, expect, test } from "bun:test";
import { ConnectorError } from "@futurity/atlas-connector";
import { ESB_CORE_CATALOG } from "./catalog";
import {
  ESB_CORE_ORIGIN,
  EsbCoreApi,
  EsbCoreError,
  makeDeadline,
  resetEsbCoreTokenCacheForTests,
} from "./esb-api";

const CREDENTIALS = { username: "atlas-reader", password: "private-password" };
const PRODUCTS = ESB_CORE_CATALOG.find((object) => object.name === "products")!;
const BRANCHES = ESB_CORE_CATALOG.find((object) => object.name === "branches")!;
const ITEM_JOURNALS = ESB_CORE_CATALOG.find((object) => object.name === "item_journals")!;
const PRICELISTS = ESB_CORE_CATALOG.find((object) => object.name === "pricelists")!;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEsbCoreTokenCacheForTests();
});

function envelope(result: unknown, status = 200): Response {
  return Response.json({ status: "ok", code: "EC03100000", message: "OK", result }, { status });
}

function token(accessToken: string, refreshToken: string): Response {
  return envelope({ accessToken, refreshToken });
}

function failure(code: string, status = 401, message = "rejected"): Response {
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

function authHeader(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization");
}

describe("ESB Core credentials and token coordination", () => {
  test("uses the fixed production origin, trims only username, and reuses a token", async () => {
    const calls = mockFetch(({ url, init }) => {
      if (url.pathname.endsWith("/auth/login")) return token("access-1", "refresh-1");
      expect(authHeader(init)).toBe("Bearer access-1");
      return envelope({ page: 1, limit: 1, data: [], next: "" });
    });
    const api = new EsbCoreApi({ username: " atlas-reader ", password: "  private password  " });
    await api.collection(PRODUCTS, 1, 1, makeDeadline(1_000));
    await api.collection(PRODUCTS, 1, 1, makeDeadline(1_000));

    expect(calls.filter((call) => call.url.pathname.endsWith("/auth/login"))).toHaveLength(1);
    expect(calls.every((call) => call.url.origin === ESB_CORE_ORIGIN)).toBe(true);
    expect(calls[1]?.url.pathname).toBe("/core/product/list");
    expect(calls[1]?.url.searchParams.get("page")).toBe("1");
    expect(calls[1]?.url.searchParams.get("limit")).toBe("1");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      username: "atlas-reader",
      password: "  private password  ",
    });
  });

  test("rejects missing credentials without accepting password whitespace as missing", async () => {
    expect(() => new EsbCoreApi({ username: " ", password: "x" })).toThrow(ConnectorError);
    expect(() => new EsbCoreApi({ username: "x", password: "" })).toThrow(ConnectorError);
    mockFetch(() => token("access", "refresh"));
    await expect(new EsbCoreApi({ username: "x", password: " " }).authenticate(makeDeadline(100))).resolves.toBeUndefined();
  });

  test("shares one in-flight login across instances with the same credentials", async () => {
    let logins = 0;
    mockFetch(async ({ url }) => {
      if (url.pathname.endsWith("/auth/login")) {
        logins += 1;
        await Bun.sleep(20);
        return token("access-1", "refresh-1");
      }
      return envelope({ page: 1, limit: 1, data: [], next: "" });
    });
    await Promise.all([
      new EsbCoreApi(CREDENTIALS).collection(PRODUCTS, 1, 1, makeDeadline(500)),
      new EsbCoreApi(CREDENTIALS).collection(PRODUCTS, 1, 1, makeDeadline(500)),
    ]);
    expect(logins).toBe(1);
  });

  test("keeps the shared mint alive when one waiter reaches its own deadline", async () => {
    let aborted = false;
    mockFetch(async ({ init }) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30);
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      });
      return token("access-1", "refresh-1");
    });
    const api = new EsbCoreApi(CREDENTIALS);
    const long = api.authenticate(makeDeadline(500));
    await expect(api.authenticate(makeDeadline(5))).rejects.toMatchObject({ status: 408 });
    await expect(long).resolves.toBeUndefined();
    expect(aborted).toBe(false);
  });

  test("does not share tokens across credential sets", async () => {
    let logins = 0;
    mockFetch(({ url }) => {
      if (!url.pathname.endsWith("/auth/login")) throw new Error("unexpected collection");
      logins += 1;
      return token(`access-${logins}`, `refresh-${logins}`);
    });
    await Promise.all([
      new EsbCoreApi(CREDENTIALS).authenticate(makeDeadline(100)),
      new EsbCoreApi({ username: CREDENTIALS.username, password: "other" }).authenticate(makeDeadline(100)),
    ]);
    expect(logins).toBe(2);
  });
});

describe("ESB Core refresh and authorization", () => {
  test("refreshes and replays once after an invalid access token", async () => {
    let resources = 0;
    const calls = mockFetch(({ url, init }) => {
      if (url.pathname.endsWith("/auth/login")) return token("access-1", "refresh-1");
      if (url.pathname.endsWith("/auth/refresh")) {
        expect(authHeader(init)).toBe("Bearer refresh-1");
        return token("access-2", "refresh-2");
      }
      resources += 1;
      if (resources === 1) return failure("EC03100001", 403, "Invalid Token");
      expect(authHeader(init)).toBe("Bearer access-2");
      return envelope({ page: 1, limit: 1, data: [], next: "" });
    });
    await new EsbCoreApi(CREDENTIALS).collection(PRODUCTS, 1, 1, makeDeadline(1_000));
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/core/auth/login",
      "/core/product/list",
      "/core/auth/refresh",
      "/core/product/list",
    ]);
  });

  test("a stale unauthorized response cannot invalidate a newer token", async () => {
    let oldResources = 0;
    let refreshes = 0;
    let releaseStale!: () => void;
    const currentTokenUsed = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const calls = mockFetch(async ({ url, init }) => {
      if (url.pathname.endsWith("/auth/login")) return token("access-1", "refresh-1");
      if (url.pathname.endsWith("/auth/refresh")) {
        refreshes += 1;
        return token("access-2", "refresh-2");
      }
      if (authHeader(init) === "Bearer access-1") {
        oldResources += 1;
        if (oldResources === 2) await currentTokenUsed;
        return failure("EC03100001", 401, "Invalid Token");
      }
      expect(authHeader(init)).toBe("Bearer access-2");
      releaseStale();
      return envelope({ page: 1, limit: 1, data: [], next: "" });
    });
    const api = new EsbCoreApi(CREDENTIALS);
    await Promise.all([
      api.collection(PRODUCTS, 1, 1, makeDeadline(1_000)),
      api.collection(PRODUCTS, 1, 1, makeDeadline(1_000)),
    ]);
    expect(refreshes).toBe(1);
    expect(calls.filter((call) => call.url.pathname.endsWith("/auth/login"))).toHaveLength(1);
  });

  test("bounds invalid-token replay to one retry", async () => {
    const calls = mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token("access-1", "refresh-1");
      if (url.pathname.endsWith("/auth/refresh")) return token("access-2", "refresh-2");
      return failure("EC03100001", 401, "Invalid Token");
    });
    await expect(
      new EsbCoreApi(CREDENTIALS).collection(PRODUCTS, 1, 1, makeDeadline(1_000)),
    ).rejects.toThrow(/authentication remained invalid/);
    expect(calls).toHaveLength(4);
  });

  test("propagates a transient refresh failure without logging in again", async () => {
    let logins = 0;
    const calls = mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) {
        logins += 1;
        return token("access-1", "refresh-1");
      }
      if (url.pathname.endsWith("/auth/refresh")) return failure("EC03500000", 503);
      return failure("EC03100001", 401, "Invalid Token");
    });
    await expect(
      new EsbCoreApi(CREDENTIALS).collection(PRODUCTS, 1, 1, makeDeadline(1_000)),
    ).rejects.toThrow(/service unavailable/);
    expect(logins).toBe(1);
    expect(calls).toHaveLength(3);
  });

  test("falls back to login only when refresh credentials are rejected", async () => {
    let logins = 0;
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) {
        logins += 1;
        return token(`access-${logins}`, `refresh-${logins}`);
      }
      if (url.pathname.endsWith("/auth/refresh")) return failure("EC03100001", 401);
      return logins === 1
        ? failure("EC03100001", 401, "Invalid Token")
        : envelope({ page: 1, limit: 1, data: [], next: "" });
    });
    await new EsbCoreApi(CREDENTIALS).collection(PRODUCTS, 1, 1, makeDeadline(1_000));
    expect(logins).toBe(2);
  });

  test("keeps endpoint permission denial distinct from token rejection", async () => {
    mockFetch(({ url }) =>
      url.pathname.endsWith("/auth/login")
        ? token("access", "refresh")
        : failure("EC03100001", 403, "Unauthorized to access products"),
    );
    const error = await new EsbCoreApi(CREDENTIALS)
      .collection(PRODUCTS, 1, 1, makeDeadline(1_000))
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(EsbCoreError);
    expect(error).toMatchObject({ failureKind: "permission", status: 403 });
  });
});

describe("ESB Core response validation and safe failures", () => {
  test("rejects malformed token success envelopes", async () => {
    mockFetch(() => envelope({ accessToken: "access" }));
    await expect(new EsbCoreApi(CREDENTIALS).authenticate(makeDeadline(100))).rejects.toMatchObject({
      code: "invalid-token-response",
    });
  });

  test("validates direct and paged collection contracts", async () => {
    mockFetch(({ url }) => {
      if (url.pathname.endsWith("/auth/login")) return token("access", "refresh");
      if (url.pathname.endsWith(BRANCHES.path)) return envelope([{ branchID: 1 }]);
      return envelope({ page: 1, limit: 1, data: [{ productID: 1 }], next: "next" });
    });
    expect(await new EsbCoreApi(CREDENTIALS).collection(BRANCHES, 99, 99, makeDeadline(100))).toEqual({
      rows: [{ branchID: 1 }],
      hasNext: false,
    });
    expect(await new EsbCoreApi(CREDENTIALS).collection(PRODUCTS, 1, 100, makeDeadline(100))).toMatchObject({
      page: 1,
      limit: 1,
      hasNext: true,
    });
  });

  test("normalizes valid rows and rejects values that contradict the catalog", async () => {
    mockFetch(({ url }) =>
      url.pathname.endsWith("/auth/login")
        ? token("access", "refresh")
        : envelope({
            page: 1,
            limit: 1,
            data: [{ itemJournalNum: "IJ-1", itemJournalDate: "2024-01-01T09:00:00+07:00" }],
            next: "",
          }),
    );
    await expect(new EsbCoreApi(CREDENTIALS).collection(ITEM_JOURNALS, 1, 1, makeDeadline(100))).resolves.toMatchObject({
      rows: [{ itemJournalNum: "IJ-1", itemJournalDate: "2024-01-01T02:00:00.000Z" }],
    });

    for (const [object, row] of [
      [PRODUCTS, { productID: true }],
      [PRODUCTS, { productID: "1e-7" }],
      [PRICELISTS, { ID: 1, priceDate: "2024-02-30" }],
      [ITEM_JOURNALS, { itemJournalNum: "IJ-1", itemJournalDate: "not-a-datetime" }],
    ] as const) {
      resetEsbCoreTokenCacheForTests();
      mockFetch(({ url }) =>
        url.pathname.endsWith("/auth/login")
          ? token("access", "refresh")
          : envelope({ page: 1, limit: 1, data: [row], next: "" }),
      );
      await expect(new EsbCoreApi(CREDENTIALS).collection(object, 1, 1, makeDeadline(100))).rejects.toMatchObject({
        code: "malformed-response",
      });
    }
  });

  test("prioritizes a wrong page before malformed collection data", async () => {
    for (const data of [[{ productID: true }], "not-an-array"]) {
      resetEsbCoreTokenCacheForTests();
      mockFetch(({ url }) =>
        url.pathname.endsWith("/auth/login")
          ? token("access", "refresh")
          : envelope({ page: 2, limit: 1, data, next: "" }),
      );
      await expect(
        new EsbCoreApi(CREDENTIALS).collection(PRODUCTS, 1, 1, makeDeadline(100)),
      ).rejects.toMatchObject({ code: "non-progressing-page" });
    }
  });

  test("rejects malformed envelopes, rows, pages, limits, and continuation", async () => {
    const invalid = [
      {},
      { status: "ok", code: "EC03100000", result: { page: 2, limit: 1, data: [], next: "" } },
      { status: "ok", code: "EC03100000", result: { page: 1, limit: 0, data: [], next: "" } },
      {
        status: "ok",
        code: "EC03100000",
        result: { page: 1, limit: 1, data: [{ productID: 1 }, { productID: 2 }], next: "" },
      },
      { status: "ok", code: "EC03100000", result: { page: 1, limit: 1, data: ["bad"], next: "" } },
      { status: "ok", code: "EC03100000", result: { page: 1, limit: 1, data: [], next: null } },
    ];
    for (const body of invalid) {
      resetEsbCoreTokenCacheForTests();
      let call = 0;
      mockFetch(() => (call++ === 0 ? token("access", "refresh") : Response.json(body)));
      await expect(
        new EsbCoreApi(CREDENTIALS).collection(PRODUCTS, 1, 1, makeDeadline(100)),
      ).rejects.toBeInstanceOf(EsbCoreError);
    }
  });

  test("rejects redirects, network errors, and unreadable bodies without leaking secrets", async () => {
    for (const response of [
      () => new Response(null, { status: 302 }),
      () => Promise.reject(new Error(`network ${CREDENTIALS.password}`)),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`body ${CREDENTIALS.password}`));
            },
          }),
          { status: 200 },
        ),
    ]) {
      resetEsbCoreTokenCacheForTests();
      mockFetch(response);
      const error = await new EsbCoreApi(CREDENTIALS).authenticate(makeDeadline(100)).catch((value: unknown) => value);
      expect(String(error)).not.toContain(CREDENTIALS.password);
    }
  });

  test("redacts an application code that appears in credentials", async () => {
    const credentials = { username: "reader", password: "secret-EC03123456-value" };
    mockFetch(() => failure("EC03123456", 200, "do not echo credentials"));
    const error = await new EsbCoreApi(credentials).authenticate(makeDeadline(100)).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(EsbCoreError);
    expect((error as EsbCoreError).code).toBe("unknown");
    expect(String(error)).not.toContain(credentials.password);
    expect(String(error)).not.toContain("EC03123456");
  });

  test("maps request deadline exhaustion to the SDK timeout error", async () => {
    mockFetch(async ({ init }) => {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      throw new Error("unreachable");
    });
    await expect(new EsbCoreApi(CREDENTIALS).authenticate(makeDeadline(5))).rejects.toMatchObject({ status: 408 });
  });
});
