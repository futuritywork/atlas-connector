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

export type Row = Record<string, unknown>;

// how many tenants keep an open pool; past it the least recently used one closes
const MAX_POOLS = 16;

// key order never changes the key, so the same credentials always reach the same pool
function credentialsKey(credentials: Credentials): string {
  const sorted = Object.keys(credentials)
    .sort()
    .map((key) => [key, credentials[key]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// inFlight counts the callers that can still touch the pool object; eviction waits them out
type PoolLease<Pool> = { pool: Promise<Pool>; inFlight: number; evicted: boolean };

type BuiltSelect = ReturnType<typeof buildSelect>;

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
  // what the tenant types to reach their database; override when the driver takes separate parts
  readonly credentialSchema: CredentialField[] = [
    {
      key: "databaseUrl",
      label: "Database URL",
      type: "password",
      placeholder: "postgres://user:password@host:5432/db",
      help: "The whole connection URL, password included: `postgres://user:password@host:5432/db`. Use a read-only role that can see the schema this connector reads.",
    },
  ];

  /**
   * open one tenant's connection pool from their credentials; opened once per credential set and reused.
   * throw here and the tenant sees the driver's own message from `/check`.
   */
  protected abstract openPool(credentials: Credentials): Promise<Pool>;

  /** close a pool the cache evicted; the driver's own shutdown, nothing else. */
  protected abstract closePool(pool: Pool): Promise<void>;

  /**
   * the one method an author writes: one parameterized statement on that tenant's pool.
   * params bind positionally in flavor.placeholder order; values never travel inside the sql text.
   */
  abstract run(pool: Pool, sql: string, params: unknown[]): Promise<Row[]>;

  // cursor seam: a driver with real cursors overrides this to yield raw row batches for the
  // built statement; left undefined, query pages via limit/offset windows
  protected streamBatches?(
    pool: Pool,
    built: { sql: string; params: unknown[] },
    req: NativeQueryRequest,
  ): AsyncIterable<Row[]>;

  readonly #pools = new Map<string, PoolLease<Pool>>();

  /**
   * run one statement chain on this tenant's pool; the pool stays open for as long as fn holds it.
   * an override that needs the raw pool (a dialect's own `check`, say) goes through here.
   */
  protected async withPool<T>(credentials: Credentials, fn: (pool: Pool) => Promise<T>): Promise<T> {
    const lease = await this.#acquire(credentials);
    try {
      return await fn(await lease.pool);
    } finally {
      this.#release(lease);
    }
  }

  // one pool per credential set, least recently used first in insertion order
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

  // closing happens off the request path: a slow driver shutdown must not delay a query
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

  // probe and discovery sql speak to one tenant's pool through this
  async #probe<T>(credentials: Credentials, fn: (run: probes.SqlRunner) => Promise<T>): Promise<T> {
    return await this.withPool(credentials, (pool) => fn((sql, params) => this.run(pool, sql, params)));
  }

  #ctx: SqlContext | undefined;
  protected get ctx(): SqlContext {
    this.#ctx ??= {
      catalog: this.catalog,
      schema: this.schema,
      flavor: this.flavor,
      operators: new Set(this.capability().capabilities.operators),
    };
    return this.#ctx;
  }

  override capability(): AtlasJson {
    return sqlCapability(this);
  }

  // one round trip on the tenant's own pool; a dialect without a bare SELECT overrides it
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

  // sql COUNT(*) is exact, so the null "source only approximates" answer never occurs here
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
}
