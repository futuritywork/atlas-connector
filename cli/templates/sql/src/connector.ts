import { SQL } from "bun";
import type { Credentials } from "@futurity/atlas-connector";
import { postgres, SqlConnector, type Row } from "@futurity/atlas-connector/sql";
import { catalog } from "./catalog";

// as written this is a working postgres connector: the tenant's databaseUrl opens a bun SQL
// pool. another driver swaps the three methods below and nothing else.
export class MyConnector extends SqlConnector<SQL> {
  readonly slug = "my-atlas-connector";
  readonly catalog = catalog;
  readonly schema = process.env.CONNECTOR_SCHEMA ?? "public";
  override readonly flavor = postgres();

  // one pool per credential set, opened once and reused; the sdk closes it on eviction.
  // to ask the tenant for driver-specific parts instead, override credentialSchema too.
  protected override async openPool(credentials: Credentials): Promise<SQL> {
    if (!credentials.databaseUrl) throw new Error("databaseUrl is required");
    return new SQL(credentials.databaseUrl);
  }

  protected override async closePool(pool: SQL): Promise<void> {
    await pool.close();
  }

  // the only path sql text reaches the database on; params bind positionally ($1..$n), never interpolated
  async run(pool: SQL, sql: string, params: unknown[]): Promise<Row[]> {
    return (await pool.unsafe(sql, params)) as Row[];
  }
}
