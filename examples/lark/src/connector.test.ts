import { afterEach, describe, expect, test } from "bun:test";
import { LarkConnector } from "./connector";

const TENANT_A = { appId: "cli_a", appSecret: "secret-a", appToken: "base-x" };
const WRONG_SECRET = { ...TENANT_A, appSecret: "not-the-secret" };
const MISSING_BASE = { ...TENANT_A, appToken: "base-missing" };
const MINT_PATH = "/open-apis/auth/v3/tenant_access_token/internal";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// the lark endpoints discover() walks, answered from one fixture base
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

    const mine = await connector.discover(req(TENANT_A));
    expect(mine.tables.map((table) => table.name)).toEqual(["deals"]);

    paths.length = 0;
    await expect(connector.discover(req(WRONG_SECRET))).rejects.toThrow(/app secret invalid/);
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

    const answer = await new LarkConnector().discover(req(TENANT_A));
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
