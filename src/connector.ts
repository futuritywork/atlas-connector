// the server dual of Atlas's SourceClient: the protocol methods over parsed wire requests.
// serve() owns auth, body parse, timeouts, ndjson framing and the error envelope; a method gets the parsed request, credentials and deadline included.

import { columnCountsFromValues, grainFromValues, linkFromValues, sampleFromValues } from "./kit/probe-math";
import type { AtlasJson } from "./wire/atlas-json";
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
} from "./wire/schemas";
import type { SourceRow } from "./wire/vocabulary";

// returning mid-iteration ends the for-await, so the producer's cursor closes at the limit
export async function drainRows(
  batches: AsyncIterable<SourceRow[]>,
  limit?: number,
): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for await (const batch of batches) {
    for (const row of batch) rows.push(row);
    if (limit !== undefined && rows.length >= limit) return rows.slice(0, limit);
  }
  return rows;
}

export abstract class AtlasConnector {
  // #region identity

  /** stable id, `^[a-z][a-z0-9-]{2,39}$`; the same value the capability doc carries as slug. */
  abstract readonly slug: string;

  /**
   * fetched unauthenticated at connect and at every discovery: which pushdowns Atlas may use and which credentials the tenant is asked for; build it from constants.
   * give every credentialSchema entry a `placeholder` and a `help` string, short markdown naming the vendor console page the value is found on and linking its doc.
   */
  abstract capability(): AtlasJson;

  /** the cheapest upstream call that proves req.credentials; the thrown message reaches the tenant verbatim. */
  abstract check(req: CheckRequest): Promise<void>;

  // #endregion

  // #region query

  /**
   * every row Atlas reads crosses here: `/query` drains it to the request's limit, `/query/stream` frames the batches as ndjson.
   * honor every advertised filter and 422 on a field you cannot push down (`assertKnownFields`): an unfiltered row reads as a matching row.
   */
  abstract query(req: NativeQueryRequest): AsyncIterable<SourceRow[]>;

  /**
   * COUNT(*) of the same filtered request; Atlas paginates and sizes previews with it.
   * an unknown filter field must 422 here too, never widen the count.
   */
  abstract count(req: CountRequest): Promise<number>;

  /**
   * group-by pushdown Atlas tries before folding rows itself; advertise it in `endpoints`.
   * the default declines with undefined (a 204); override only where the source groups server-side.
   */
  async aggregate(_req: AggregateRequest): Promise<SourceRow[] | undefined> {
    return undefined;
  }

  // #endregion

  // #region discovery

  /** the tables, fields and keys Atlas builds a source from; called at setup and on rediscovery, so it may be slow. */
  abstract discover(req: DiscoveryRequest): Promise<DiscoveryAnswer>;

  // #endregion

  // #region profiling

  #scan(
    req: { credentials: Credentials; timeoutMs: number },
    table: string,
    fields: string[],
  ): AsyncIterable<SourceRow[]> {
    return this.query({
      table,
      and: [],
      sort: [],
      fields,
      credentials: req.credentials,
      timeoutMs: req.timeoutMs,
    });
  }

  /**
   * per-column non-null and distinct counts; Atlas picks join keys off them, so a wrong count mispicks joins.
   * the default scans the table through `query`; override with source-side COUNT DISTINCT, or answer null to decline.
   */
  async profileColumns(req: ProbeColumnsRequest): Promise<TableColumnsProbe | null> {
    const rows = await drainRows(this.#scan(req, req.table, req.columns));
    const columns: Record<string, unknown[]> = {};
    for (const name of req.columns) columns[name] = rows.map((row) => row[name] ?? null);
    return columnCountsFromValues(columns);
  }

  /**
   * orphan rate of one candidate foreign key; Atlas keeps or drops the join hop on it.
   * the default scans both columns through `query`; override with a source-side LEFT JOIN, or answer null to decline.
   */
  async profileLink(req: ProbeLinkRequest): Promise<LinkProbe | null> {
    const from = await drainRows(this.#scan(req, req.fromTable, [req.fromColumn]));
    const to = await drainRows(this.#scan(req, req.toTable, [req.toColumn]));
    return linkFromValues(
      from.map((row) => row[req.fromColumn] ?? null),
      to.map((row) => row[req.toColumn] ?? null),
    );
  }

  /**
   * rows, non-nulls and distincts for one column; Atlas reads a table's grain from it.
   * the default scans the column through `query`; override with source-side counts, or answer null to decline.
   */
  async profileGrain(req: ProbeGrainRequest): Promise<GrainProbe | null> {
    const rows = await drainRows(this.#scan(req, req.table, [req.column]));
    return grainFromValues(rows.map((row) => row[req.column] ?? null));
  }

  /**
   * the table's exact row count, for the places an estimate would corrupt Atlas's math.
   * the default is a full scan through `query` with no columns; override for a cheap exact count, answer null when the source only estimates.
   */
  async exactCount(req: CountExactRequest): Promise<number | null> {
    let count = 0;
    for await (const batch of this.#scan(req, req.table, [])) count += batch.length;
    return count;
  }

  /**
   * the sorted distinct head of one column as text; Atlas matches keys across sources with it.
   * the default scans the column through `query` and sorts in memory; override with ORDER BY … LIMIT to read only the head.
   */
  async sampleColumnValues(req: SampleKeyValuesRequest): Promise<string[]> {
    const rows = await drainRows(this.#scan(req, req.table, [req.column]));
    return sampleFromValues(
      rows.map((row) => row[req.column] ?? null),
      req.type,
      req.limit,
    );
  }

  // #endregion
}
