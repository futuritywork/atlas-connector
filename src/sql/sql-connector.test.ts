import { describe, expect, test } from "bun:test";
import type { CheckRequest, Credentials, NativeQueryRequest } from "../wire/schemas";
import { col, defineCatalog, type Table } from "./catalog";
import { type Row, SqlConnector } from "./sql-connector";

const orders: Table = {
  name: "orders",
  description: "",
  primaryKey: ["id"],
  foreignKeys: [],
  columns: [col("id", "int", "number", { unique: true })],
};

type FakePool = { url: string; closed: boolean };

class FakeSqlConnector extends SqlConnector<FakePool> {
  readonly slug = "fake-sql";
  readonly catalog = defineCatalog([orders]);
  readonly schema = "public";
  readonly opened: string[] = [];
  readonly pools: FakePool[] = [];
  readonly ran: { url: string; sql: string }[] = [];
  #flakyOpens = 0;

  protected async openPool(credentials: Credentials): Promise<FakePool> {
    const url = credentials.databaseUrl ?? "";
    // the first open of "flaky" fails, later ones succeed
    if (url === "flaky" && this.#flakyOpens++ === 0) {
      throw new Error("password authentication failed");
    }
    this.opened.push(url);
    const pool = { url, closed: false };
    this.pools.push(pool);
    return pool;
  }

  protected async closePool(pool: FakePool): Promise<void> {
    pool.closed = true;
  }

  async run(pool: FakePool, sql: string, _params: unknown[]): Promise<Row[]> {
    this.ran.push({ url: pool.url, sql });
    return [{ id: 1 }];
  }

  poolFor(credentials: Credentials): Promise<FakePool> {
    return this.withPool(credentials, async (pool) => pool);
  }
}

const creds = (databaseUrl: string): Credentials => ({ databaseUrl });
const check = (databaseUrl: string): CheckRequest => ({ credentials: creds(databaseUrl), timeoutMs: 1000 });

const query = (databaseUrl: string): NativeQueryRequest => ({
  table: "orders",
  and: [],
  sort: [],
  fields: ["id"],
  credentials: creds(databaseUrl),
  timeoutMs: 1000,
});

// closing lands a turn later
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("per-tenant pools", () => {
  test("one pool per credential set, reused across calls", async () => {
    const connector = new FakeSqlConnector();
    await connector.check(check("a"));
    await connector.check(check("a"));
    await connector.check(check("b"));
    expect(connector.opened).toEqual(["a", "b"]);
    expect(connector.ran.map((call) => call.url)).toEqual(["a", "a", "b"]);
  });

  test("key order in the credentials object never opens a second pool", async () => {
    const connector = new FakeSqlConnector();
    await connector.check({ credentials: { databaseUrl: "a", schema: "s" }, timeoutMs: 1000 });
    await connector.check({ credentials: { schema: "s", databaseUrl: "a" }, timeoutMs: 1000 });
    expect(connector.opened).toEqual(["a"]);
  });

  test("check is one round trip on that tenant's pool", async () => {
    const connector = new FakeSqlConnector();
    await connector.check(check("a"));
    expect(connector.ran).toEqual([{ url: "a", sql: "SELECT 1" }]);
  });

  test("a pool that failed to open is not cached", async () => {
    const connector = new FakeSqlConnector();
    await expect(connector.check(check("flaky"))).rejects.toThrow("password authentication failed");
    await connector.check(check("flaky"));
    expect(connector.opened).toEqual(["flaky"]);
  });

  test("past the cap the least recently used pool closes", async () => {
    const connector = new FakeSqlConnector();
    const pools: FakePool[] = [];
    for (let i = 0; i < 17; i++) pools.push(await connector.poolFor(creds(`t${i}`)));
    await settled();
    expect(pools[0]?.closed).toBe(true);
    expect(pools[1]?.closed).toBe(false);
    expect(pools[16]?.closed).toBe(false);
    // t0 was evicted, so it reopens
    await connector.check(check("t0"));
    expect(connector.opened.filter((url) => url === "t0").length).toBe(2);
  });

  test("eviction leaves a pool open while a query still holds it", async () => {
    const connector = new FakeSqlConnector();
    const rows = connector.query(query("t0"))[Symbol.asyncIterator]();
    await rows.next();
    const held = connector.pools[0];

    for (let i = 1; i < 17; i++) await connector.poolFor(creds(`t${i}`));
    await settled();
    expect(held?.closed).toBe(false);

    await rows.return?.();
    await settled();
    expect(held?.closed).toBe(true);
  });
});
