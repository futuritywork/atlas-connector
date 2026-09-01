// SqlConnector: every protocol method derived from one abstract run(pool, sql, params) + a catalog

import { createHash } from "node:crypto";
import { AtlasConnector } from "../connector";
import type { AtlasJson, CredentialField } from "../wire/atlas-json";
import { CONNECTOR_LIMITS } from "../wire/limits";
import type {
  AggregateRequest,
  CheckRequest,
  CountExactRequest,
  CountRequest,
  Credentials,
  DiscoveryAnswer,
  DiscoveryRequest,
  GrainProbe,
  LinkProbe,
  NativeQueryRequest,
  ProbeColumnsRequest,
  ProbeGrainRequest,
  ProbeLinkRequest,
  SampleKeyValuesRequest,
  TableColumnsProbe,
} from "../wire/schemas";
import type { SourceRow } from "../wire/vocabulary";
import { buildAggregate, renderAggregateRows } from "./aggregate";
import { sqlCapability } from "./capability";
import type { Catalog } from "./catalog";
import { discovery } from "./discovery";
import { postgres, type SqlContext, type SqlFlavor } from "./flavor";
import * as probes from "./probes";
import { buildCount, buildSelect, renderRows } from "./select";
import { requireTable } from "./sql-util";

// open pools; the least recently used closes past this
const MAX_POOLS = 16;

export type Row = Record<string, unknown>;

// an evicted lease closes once inFlight reaches 0
type PoolLease<Pool> = { pool: Promise<Pool>; inFlight: number; evicted: boolean };

type BuiltSelect = ReturnType<typeof buildSelect>;

// sorted, so key order never changes the key
function credentialsKey(credentials: Credentials): string {
  const sorted = Object.keys(credentials)
    .sort()
    .map((key) => [key, credentials[key]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function* chunked(rows: Row[], built: BuiltSelect): Generator<SourceRow[]> {
  for (let i = 0; i < rows.length; i += CONNECTOR_LIMITS.rowsPerBatch) {
    yield renderRows(rows.slice(i, i + CONNECTOR_LIMITS.rowsPerBatch), built.columns);
  }
}

export abstract class SqlConnector<Pool = unknown> extends AtlasConnector {
  abstract readonly catalog: Catalog;
  abstract readonly schema: string;
  readonly flavor: SqlFlavor = postgres();
  // true only when every declared unique/primaryKey is a real db constraint; the honest default is false
  readonly enforcesDeclaredKeys: boolean = false;
  // override when the driver takes separate parts
  readonly credentialSchema: CredentialField[] = [
    {
      key: "databaseUrl",
      label: "Database URL",
      type: "password",
      required: true,
      placeholder: "postgres://user:password@host:5432/db",
      help: "The whole connection URL, password included: `postgres://user:password@host:5432/db`. Use a read-only role that can see the schema this connector reads.",
    },
  ];

  readonly #pools = new Map<string, PoolLease<Pool>>();
  #ctx: SqlContext | undefined;

  /**
   * one tenant's pool from their credentials; opened once per credential set and reused.
   * throw here and the tenant sees the driver's own message from `/check`.
   */
  protected abstract openPool(credentials: Credentials): Promise<Pool>;

  /** the driver's own shutdown for a pool the cache evicted. */
  protected abstract closePool(pool: Pool): Promise<void>;

  /** one parameterized statement on that tenant's pool; params bind positionally in flavor.placeholder order, never inside the sql text. */
  abstract run(pool: Pool, sql: string, params: unknown[]): Promise<Row[]>;

  // cursor seam: a driver with real cursors overrides this to yield raw row batches for the
  // built statement; left undefined, query pages via limit/offset windows
  protected streamBatches?(
    pool: Pool,
    built: { sql: string; params: unknown[] },
    req: NativeQueryRequest,
  ): AsyncIterable<Row[]>;

  // #region pool cache

  /** the pool stays open while fn holds it; an override that needs the raw pool (a dialect's own `check`) goes through here. */
  protected async withPool<T>(credentials: Credentials, fn: (pool: Pool) => Promise<T>): Promise<T> {
    const lease = await this.#acquire(credentials);
    try {
      return await fn(await lease.pool);
    } finally {
      this.#release(lease);
    }
  }

  // map order is lru order: delete+set marks recent
  async #acquire(credentials: Credentials): Promise<PoolLease<Pool>> {
    const key = credentialsKey(credentials);
    const cached = this.#pools.get(key);
    if (cached) {
      this.#pools.delete(key);
      this.#pools.set(key, cached);
      cached.inFlight++;
      try {
        await cached.pool;
      } catch (error) {
        this.#release(cached);
        throw error;
      }
      return cached;
    }

    const lease: PoolLease<Pool> = { pool: this.openPool(credentials), inFlight: 1, evicted: false };
    this.#pools.set(key, lease);
    try {
      await lease.pool;
    } catch (error) {
      // a cached rejection would fail the retry too
      if (this.#pools.get(key) === lease) this.#pools.delete(key);
      this.#release(lease);
      throw error;
    }
    this.#evictOverflow();
    return lease;
  }

  #release(lease: PoolLease<Pool>): void {
    lease.inFlight--;
    if (lease.evicted && lease.inFlight === 0) this.#close(lease);
  }

  // off the request path: a slow shutdown must not delay a query
  #close(lease: PoolLease<Pool>): void {
    void lease.pool.then((pool) => this.closePool(pool)).catch(() => {});
  }

  #evictOverflow(): void {
    for (const [key, lease] of [...this.#pools]) {
      if (this.#pools.size <= MAX_POOLS) return;
      this.#pools.delete(key);
      lease.evicted = true;
      if (lease.inFlight === 0) this.#close(lease);
    }
  }

  async #probe<T>(credentials: Credentials, fn: (run: probes.SqlRunner) => Promise<T>): Promise<T> {
    return await this.withPool(credentials, (pool) => fn((sql, params) => this.run(pool, sql, params)));
  }

  // #endregion

  protected get ctx(): SqlContext {
    this.#ctx ??= {
      catalog: this.catalog,
      schema: this.schema,
      flavor: this.flavor,
      operators: new Set(this.capability().capabilities.operators),
    };
    return this.#ctx;
  }

  // #region protocol

  override capability(): AtlasJson {
    return sqlCapability(this);
  }

  // a dialect without a bare SELECT 1 overrides this
  override async check(req: CheckRequest): Promise<void> {
    await this.withPool(req.credentials, (pool) => this.run(pool, "SELECT 1", []));
  }

  override async discover(req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    return await this.#probe(req.credentials, (run) => discovery(this.ctx, run));
  }

  override async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    const lease = await this.#acquire(req.credentials);
    try {
      yield* this.#queryPool(await lease.pool, req);
    } finally {
      this.#release(lease);
    }
  }

  async *#queryPool(pool: Pool, req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    if (this.streamBatches) {
      const built = buildSelect(this.ctx, req);
      for await (const batch of this.streamBatches(pool, built, req)) {
        yield* chunked(batch, built);
      }
      return;
    }

    const base = requireTable(this.ctx, req.table);
    if (req.sort.length === 0 && base.primaryKey.length === 0) {
      const built = buildSelect(this.ctx, req);
      yield* chunked(await this.run(pool, built.sql, built.params), built);
      return;
    }

    // limit/offset pages need a total order; the primary key tiebreaks whatever the caller sorted by
    const tiebreak = base.primaryKey
      .filter((field) => !req.sort.some((sort) => sort.field === field))
      .map((field) => ({ field, dir: "asc" as const }));
    const sort = [...req.sort, ...tiebreak];
    let remaining = req.limit ?? Number.POSITIVE_INFINITY;
    let offset = req.offset ?? 0;
    while (remaining > 0) {
      const limit = Math.min(CONNECTOR_LIMITS.rowsPerBatch, remaining);
      const page = buildSelect(this.ctx, { ...req, sort, limit, offset });
      const rows = await this.run(pool, page.sql, page.params);
      if (rows.length > 0) yield renderRows(rows, page.columns);
      remaining -= rows.length;
      offset += rows.length;
      if (rows.length < limit) return;
    }
  }

  override async count(req: CountRequest): Promise<number> {
    const built = buildCount(this.ctx, req);
    return await this.withPool(req.credentials, async (pool) =>
      Number(probes.firstRow(await this.run(pool, built.sql, built.params)).count),
    );
  }

  // COUNT(*) is exact, so never null
  override async exactCount(req: CountExactRequest): Promise<number> {
    return await this.#probe(req.credentials, (run) => probes.countExact(this.ctx, run, req));
  }

  override async sampleColumnValues(req: SampleKeyValuesRequest): Promise<string[]> {
    return await this.#probe(req.credentials, (run) => probes.sampleKeyValues(this.ctx, run, req));
  }

  override async profileColumns(req: ProbeColumnsRequest): Promise<TableColumnsProbe> {
    return await this.#probe(req.credentials, (run) => probes.probeColumns(this.ctx, run, req));
  }

  override async profileLink(req: ProbeLinkRequest): Promise<LinkProbe> {
    return await this.#probe(req.credentials, (run) => probes.probeLink(this.ctx, run, req));
  }

  override async profileGrain(req: ProbeGrainRequest): Promise<GrainProbe> {
    return await this.#probe(req.credentials, (run) => probes.probeGrain(this.ctx, run, req));
  }

  // a null build declines the whole aggregate; undefined crosses serve() as a 204, never as rows
  override async aggregate(req: AggregateRequest): Promise<SourceRow[] | undefined> {
    const built = buildAggregate(this.ctx, req, req.limit);
    if (!built) return undefined;
    return await this.withPool(req.credentials, async (pool) =>
      renderAggregateRows(await this.run(pool, built.sql, built.params), built.columns),
    );
  }

  // #endregion
}
