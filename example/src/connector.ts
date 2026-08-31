import { SQL } from "bun";
import { CONNECTOR_LIMITS, type NativeQueryStreamRequest } from "@futurity/atlas-connector";
import { type Row, SqlConnector } from "@futurity/atlas-connector/sql";
import { catalog } from "./catalog";
import { CONFIG } from "./env";

// naive date_trunc bucketing and to_char rendering are cluster-independent only on a UTC
// session; the pin rides every pooled connection's startup packet at no round trip
function pinnedUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", "-c TimeZone=UTC");
  return parsed.toString();
}

export class BrightlineConnector extends SqlConnector {
  readonly slug = CONFIG.slug;
  readonly catalog = catalog;
  readonly schema = CONFIG.schema;
  // keys come only from real pg constraints (PKs + owners.email UNIQUE)
  override readonly enforcesDeclaredKeys = true;

  private readonly db = new SQL(pinnedUrl(CONFIG.databaseUrl));

  // the only path SQL text reaches pg on; values never travel inside the statement string
  async run(sql: string, params: unknown[]): Promise<Row[]> {
    return (await this.db.unsafe(sql, params)) as Row[];
  }

  // real pg cursor instead of limit/offset windows; framing, heartbeat, and both stream
  // deadlines are serve()'s job — this only produces raw batches and cleans up its connection
  protected override async *streamBatches(
    built: { sql: string; params: unknown[] },
    req: NativeQueryStreamRequest,
  ): AsyncIterable<Row[]> {
    const cursor = `"__brightline_stream"`;
    const reserved = await this.db.reserve();
    try {
      await reserved.unsafe("BEGIN");
      await reserved.unsafe(`SET LOCAL statement_timeout = ${Math.ceil(req.maxTimeoutMs)}`);
      await reserved.unsafe(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${built.sql}`, built.params);
      for (;;) {
        const rows = (await reserved.unsafe(
          `FETCH FORWARD ${CONNECTOR_LIMITS.rowsPerBatch} FROM ${cursor}`,
        )) as Row[];
        if (rows.length > 0) yield rows;
        if (rows.length < CONNECTOR_LIMITS.rowsPerBatch) return;
      }
    } finally {
      try {
        await reserved.unsafe("ROLLBACK");
      } catch {}
      try {
        reserved.release();
      } catch {}
    }
  }
}
