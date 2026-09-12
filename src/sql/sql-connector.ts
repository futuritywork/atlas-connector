// SqlConnector: every protocol method derived from one abstract run(pool, sql, params) + a catalog

import { createHash } from "node:crypto";
import { AtlasConnector, type QueryChunk } from "../connector";
import type { CapabilityDoc, CredentialField } from "../wire/atlas-json";
import { CONNECTOR_LIMITS } from "../wire/limits";
import type {
  AggregateRequest,
  CardinalityRequest,
  CheckRequest,
  CountRequest,
  Credentials,
  DiscoveryAnswer,
  DiscoveryRequest,
  EntitySize,
  LinkHitRate,
  LinkHitRateRequest,
  NativeQueryRequest,
  SizeRequest,
  TableCardinality,
} from "../wire/schemas";
import type { SourceRow } from "../wire/vocabulary";
import { buildAggregate, renderAggregateRows } from "./aggregate";
import { sqlCapability } from "./capability";
import type { Catalog } from "./catalog";
import { discovery } from "./discovery";
import { postgres, type SqlContext, type SqlFlavor } from "./flavor";
import * as measure from "./measure";
import { buildCount, buildSelect, type ProjectedColumn, renderRows } from "./select";
import { requireTable } from "./sql-util";

const MAX_POOLS = 16; // open pools; the least recently used closes past this

export type Row = Record<string, unknown>;

// an evicted lease closes once inFlight reaches 0
type PoolLease<Pool> = { pool: Promise<Pool>; inFlight: number; evicted: boolean };

// sorted, so key order never changes the key
function credentialsKey(credentials: Credentials): string {
  const sorted = Object.keys(credentials)
    .sort()
    .map((key) => [key, credentials[key]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function* chunked(rows: Row[], columns: ProjectedColumn[]): Generator<SourceRow[]> {
  for (let i = 0; i < rows.length; i += CONNECTOR_LIMITS.rowsPerBatch) {
    yield renderRows(rows.slice(i, i + CONNECTOR_LIMITS.rowsPerBatch), columns);
  }
}

export abstract class SqlConnector<Pool = unknown> extends AtlasConnector {
  abstract readonly catalog: Catalog;
  abstract readonly schema: string;
  readonly flavor: SqlFlavor = postgres();
  // true only when every declared unique/primaryKey is a real db constraint
  readonly keysEnforced: boolean = false;
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

  /** one pool per credential set, reused; a throw here reaches the tenant through `/check`. */
  protected abstract openPool(credentials: Credentials): Promise<Pool>;

  /** the driver's own shutdown for a pool the cache evicted. */
  protected abstract closePool(pool: Pool): Promise<void>;

  /** one parameterized statement; params bind in flavor.placeholder order, never spliced into the sql. */
  abstract run(pool: Pool, sql: string, params: unknown[]): Promise<Row[]>;

  // a driver with real cursors overrides this to yield raw batches; undefined pages via limit/offset
  protected streamBatches?(
    pool: Pool,
    built: { sql: string; params: unknown[] },
    req: NativeQueryRequest,
  ): AsyncIterable<Row[]>;

  // #region pool cache

  /** the pool stays open while fn holds it; an override needing the raw pool goes through here. */
  protected async withPool<T>(credentials: Credentials, fn: (pool: Pool) => Promise<T>): Promise<T> {
    const lease = await this.#acquire(credentials);
    try {
      return await fn(await lease.pool);
    } finally {
      this.#release(lease);
    }
  }

  async #acquire(credentials: Credentials): Promise<PoolLease<Pool>> {
    const key = credentialsKey(credentials);
    const cached = this.#pools.get(key);
    const lease = cached ?? { pool: this.openPool(credentials), inFlight: 0, evicted: false };

    // lru order is map order: delete+set marks recent
    this.#pools.delete(key);
    this.#pools.set(key, lease);
    lease.inFlight++;

    try {
      await lease.pool;
    } catch (error) {
      // a cached rejection would fail the retry too
      if (this.#pools.get(key) === lease) this.#pools.delete(key);
      this.#release(lease);
      throw error;
    }

    if (!cached) this.#evictOverflow();
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

  async #withRunner<T>(
    credentials: Credentials,
    fn: (run: measure.SqlRunner) => Promise<T>,
  ): Promise<T> {
    return await this.withPool(credentials, async (pool) => {
      const run: measure.SqlRunner = (sql, params) => this.run(pool, sql, params);
      return await fn(run);
    });
  }

  // #endregion

  protected get ctx(): SqlContext {
    this.#ctx ??= {
      catalog: this.catalog,
      schema: this.schema,
      flavor: this.flavor,
      operators: new Set(this.capabilities().capabilities.operators),
    };
    return this.#ctx;
  }

  // #region protocol

  override capabilities(): CapabilityDoc {
    return sqlCapability(this);
  }

  // a dialect without a bare SELECT 1 overrides this
  override async check(req: CheckRequest): Promise<void> {
    await this.withPool(req.credentials, (pool) => this.run(pool, "SELECT 1", []));
  }

  override async discovery(req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    return await this.#withRunner(req.credentials, (run) => discovery(this.ctx, run));
  }

  // filters, sort and window all run in one statement, so served is true for all three
  override async *query(req: NativeQueryRequest): AsyncIterable<QueryChunk> {
    const lease = await this.#acquire(req.credentials);
    try {
      yield { served: { filters: true, sort: true, window: true } };
      yield* this.#queryPool(await lease.pool, req);
    } finally {
      this.#release(lease);
    }
  }

  async *#queryPool(pool: Pool, req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    if (this.streamBatches) {
      const built = buildSelect(this.ctx, req);
      for await (const batch of this.streamBatches(pool, built, req)) {
        yield* chunked(batch, built.columns);
      }
      return;
    }

    const base = requireTable(this.ctx, req.table);

    // nothing to page by, so one statement is the whole answer
    if (req.sort.length === 0 && base.primaryKey.length === 0) {
      const built = buildSelect(this.ctx, req);
      yield* chunked(await this.run(pool, built.sql, built.params), built.columns);
      return;
    }

    // limit/offset pages need a total order; the primary key tiebreaks the caller's sort
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
      yield* chunked(rows, page.columns);
      remaining -= rows.length;
      offset += rows.length;
      if (rows.length < limit) return;
    }
  }

  override async count(req: CountRequest): Promise<number> {
    const built = buildCount(this.ctx, req);
    return await this.#withRunner(req.credentials, async (run) =>
      Number(measure.firstRow(await run(built.sql, built.params)).count),
    );
  }

  override async size(req: SizeRequest): Promise<EntitySize> {
    return await this.#withRunner(req.credentials, (run) => measure.size(this.ctx, run, req));
  }

  override async cardinality(req: CardinalityRequest): Promise<TableCardinality> {
    return await this.#withRunner(req.credentials, (run) => measure.cardinality(this.ctx, run, req));
  }

  override async linkHitRate(req: LinkHitRateRequest): Promise<LinkHitRate> {
    return await this.#withRunner(req.credentials, (run) => measure.linkHitRate(this.ctx, run, req));
  }

  // buildAggregate returns null to decline; undefined becomes serve()'s 204, never rows
  override async aggregate(req: AggregateRequest): Promise<SourceRow[] | undefined> {
    const built = buildAggregate(this.ctx, req, req.limit);
    if (!built) return undefined;
    return await this.#withRunner(req.credentials, async (run) =>
      renderAggregateRows(await run(built.sql, built.params), built.columns),
    );
  }

  // #endregion
}
