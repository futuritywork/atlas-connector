// SqlConnector: all ten protocol methods derived from one abstract run(sql, params) + a catalog

import { AtlasConnector } from "../connector";
import type { AtlasJson } from "../wire/atlas-json";
import { CONNECTOR_LIMITS } from "../wire/limits";
import type {
  AggregateRequest,
  CountExactRequest,
  CountRequest,
  DiscoveryAnswer,
  DiscoveryRequest,
  GrainProbe,
  LinkProbe,
  NativeQueryRequest,
  NativeQueryStreamRequest,
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

type BuiltSelect = ReturnType<typeof buildSelect>;

function* chunked(rows: Row[], built: BuiltSelect): Generator<SourceRow[]> {
  for (let i = 0; i < rows.length; i += CONNECTOR_LIMITS.rowsPerBatch) {
    yield renderRows(rows.slice(i, i + CONNECTOR_LIMITS.rowsPerBatch), built.columns);
  }
}

export abstract class SqlConnector extends AtlasConnector {
  abstract readonly catalog: Catalog;
  abstract readonly schema: string;
  readonly flavor: SqlFlavor = postgres();
  // true only when every declared unique/primaryKey is a real db constraint; the honest default is false
  readonly enforcesDeclaredKeys: boolean = false;

  // the one method an author writes: one parameterized statement against their database.
  // params bind positionally in flavor.placeholder order; values never travel inside the sql text
  abstract run(sql: string, params: unknown[]): Promise<Row[]>;

  // cursor seam: a driver with real cursors overrides this to yield raw row batches for the
  // built statement; left undefined, queryStream pages via limit/offset windows
  protected streamBatches?(
    built: { sql: string; params: unknown[] },
    req: NativeQueryStreamRequest,
  ): AsyncIterable<Row[]>;

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

  private readonly runner: probes.SqlRunner = (sql, params) => this.run(sql, params);

  override capability(): AtlasJson {
    return sqlCapability(this);
  }

  override async discovery(_req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    return await discovery(this.ctx, this.runner);
  }

  override async query(req: NativeQueryRequest): Promise<SourceRow[]> {
    const built = buildSelect(this.ctx, req);
    return renderRows(await this.run(built.sql, built.params), built.columns);
  }

  override async *queryStream(req: NativeQueryStreamRequest): AsyncIterable<SourceRow[]> {
    if (this.streamBatches) {
      const built = buildSelect(this.ctx, req);
      for await (const batch of this.streamBatches(built, req)) {
        yield* chunked(batch, built);
      }
      return;
    }
    const base = requireTable(this.ctx, req.table);
    if (req.sort.length === 0 && base.primaryKey.length === 0) {
      const built = buildSelect(this.ctx, req);
      yield* chunked(await this.run(built.sql, built.params), built);
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
      const rows = await this.run(page.sql, page.params);
      if (rows.length > 0) yield renderRows(rows, page.columns);
      remaining -= rows.length;
      offset += rows.length;
      if (rows.length < limit) return;
    }
  }

  override async count(req: CountRequest): Promise<number> {
    const built = buildCount(this.ctx, req);
    return Number(probes.firstRow(await this.run(built.sql, built.params)).count);
  }

  override async countExact(req: CountExactRequest): Promise<number | null> {
    return await probes.countExact(this.ctx, this.runner, req);
  }

  override async sampleKeyValues(req: SampleKeyValuesRequest): Promise<string[]> {
    return await probes.sampleKeyValues(this.ctx, this.runner, req);
  }

  override async probeColumns(req: ProbeColumnsRequest): Promise<TableColumnsProbe | null> {
    return await probes.probeColumns(this.ctx, this.runner, req);
  }

  override async probeLink(req: ProbeLinkRequest): Promise<LinkProbe | null> {
    return await probes.probeLink(this.ctx, this.runner, req);
  }

  override async probeGrain(req: ProbeGrainRequest): Promise<GrainProbe | null> {
    return await probes.probeGrain(this.ctx, this.runner, req);
  }

  // a null build declines the whole aggregate; undefined crosses serve() as a 204, never as rows
  override async aggregate(req: AggregateRequest): Promise<SourceRow[] | undefined> {
    const built = buildAggregate(this.ctx, req, req.limit);
    if (!built) return undefined;
    return renderAggregateRows(await this.run(built.sql, built.params), built.columns);
  }
}
