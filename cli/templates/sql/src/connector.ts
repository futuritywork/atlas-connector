import { postgres, SqlConnector, type Row } from "@futurity/atlas-connector/sql";
import { catalog } from "./catalog";

export class MyConnector extends SqlConnector {
  readonly slug = "my-atlas-connector";
  readonly catalog = catalog;
  readonly schema = process.env.CONNECTOR_SCHEMA ?? "public";
  readonly flavor = postgres();

  // YOUR CODE HERE: run one parameterized statement against your database and return the rows.
  // params bind positionally ($1..$n); never interpolate values into the sql text.
  async run(sql: string, params: unknown[]): Promise<Row[]> {
    throw new Error("connect your database here");
  }
}
