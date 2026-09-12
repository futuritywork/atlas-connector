import { SQL } from "bun";
import { CONNECTOR_LIMITS, type Credentials, type NativeQueryRequest } from "@futurity/atlas-connector";
import { type Row, SqlConnector } from "@futurity/atlas-connector/sql";
import { catalog } from "./catalog";
import { CONFIG } from "./env";

const CURSOR = `"__brightline_stream"`;

// naive date_trunc and to_char are cluster-independent only on a UTC session, pinned in the startup packet
function pinnedUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", "-c TimeZone=UTC");
  return parsed.toString();
}

export class BrightlineConnector extends SqlConnector<SQL> {
  readonly slug = CONFIG.slug;
  readonly catalog = catalog;
  readonly schema = CONFIG.schema;
  override readonly keysEnforced = true; // keys come only from real pg constraints (PKs + owners.email UNIQUE)

  protected override async openPool(credentials: Credentials): Promise<SQL> {
    if (!credentials.databaseUrl) throw new Error("databaseUrl is required");
    return new SQL(pinnedUrl(credentials.databaseUrl));
  }

  protected override async closePool(pool: SQL): Promise<void> {
    await pool.close();
  }

  // the only path SQL text reaches pg on; values never travel inside the statement string
  async run(pool: SQL, sql: string, params: unknown[]): Promise<Row[]> {
    return (await pool.unsafe(sql, params)) as Row[];
  }

  // a real pg cursor instead of limit/offset windows; framing and deadlines are serve()'s job
  protected override async *streamBatches(
    pool: SQL,
    built: { sql: string; params: unknown[] },
    req: NativeQueryRequest,
  ): AsyncIterable<Row[]> {
    const reserved = await pool.reserve();
    const fetchNext = `FETCH FORWARD ${CONNECTOR_LIMITS.rowsPerBatch} FROM ${CURSOR}`;
    try {
      await reserved.unsafe("BEGIN");
      await reserved.unsafe(`SET LOCAL statement_timeout = ${req.timeoutMs}`);
      await reserved.unsafe(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${built.sql}`, built.params);
      for (;;) {
        const rows = (await reserved.unsafe(fetchNext)) as Row[];
        if (rows.length > 0) yield rows;
        if (rows.length < CONNECTOR_LIMITS.rowsPerBatch) return;
      }
    } finally {
      // the consumer can walk away mid-stream, and a rollback on a dead connection is not ours to report
      await reserved.unsafe("ROLLBACK").catch(() => {});
      reserved.release();
    }
  }
}
