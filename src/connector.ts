import type { CapabilityDoc } from "./wire/atlas-json";
import { CONNECTOR_LIMITS } from "./wire/limits";
import type {
  AggregateRequest,
  CardinalityRequest,
  CheckRequest,
  CountRequest,
  DiscoveryAnswer,
  DiscoveryRequest,
  EntitySize,
  LinkHitRate,
  LinkHitRateRequest,
  NativeQueryRequest,
  Served,
  SizeRequest,
  TableCardinality,
} from "./wire/schemas";
import type { SourceRow } from "./wire/vocabulary";

/** one batch of rows, or the plan line that precedes them all. */
export type QueryChunk = SourceRow[] | { served: Served };

/** announces nothing: the rows are a superset the host filters, sorts and windows itself. */
export const SERVED_NOTHING: Served = { filters: false, sort: false, window: false };

/** applies offset and limit to already-filtered batches; an early return closes the source iterator. */
export async function* windowRows(
  batches: AsyncIterable<SourceRow[]> | Iterable<SourceRow[]>,
  request: Pick<NativeQueryRequest, "offset" | "limit">,
): AsyncIterable<SourceRow[]> {
  let offset = request.offset ?? 0;
  let remaining = request.limit ?? Number.POSITIVE_INFINITY;

  for await (const batch of batches) {
    const start = Math.min(offset, batch.length);
    const end = Math.min(batch.length, start + remaining);
    offset -= start;

    // an in-window batch that already fits one line goes out uncopied
    const wholeBatchFits = start === 0 && end === batch.length && end <= CONNECTOR_LIMITS.rowsPerBatch;
    if (wholeBatchFits) {
      if (batch.length > 0) yield batch;
    } else {
      for (let index = start; index < end; index += CONNECTOR_LIMITS.rowsPerBatch) {
        yield batch.slice(index, Math.min(index + CONNECTOR_LIMITS.rowsPerBatch, end));
      }
    }

    remaining -= end - start;
    if (remaining === 0) return;
  }
}

/** the class a connector extends; serve() adds auth, parsing, deadlines and the error envelope. */
export abstract class AtlasConnector {
  // #region required

  /** stable id, `^[a-z][a-z0-9-]{2,39}$`, the same value the capability doc carries. */
  abstract readonly slug: string;

  /** the pushdowns and the credentials to ask for, fetched unauthenticated; see defineCapability. */
  abstract capabilities(): CapabilityDoc;

  /** the cheapest upstream call that proves req.credentials; the thrown message reaches the tenant. */
  abstract check(req: CheckRequest): Promise<void>;

  /** yield `{ served }` before the first batch; `assertKnownFields` 422s a field you cannot answer. */
  abstract query(req: NativeQueryRequest): AsyncIterable<QueryChunk>;

  /** the tables, fields and keys a source is built from; slow is fine, it runs at setup and rediscovery. */
  abstract discovery(req: DiscoveryRequest): Promise<DiscoveryAnswer>;

  // #endregion

  // #region optional measurement

  /** the whole table's row count from upstream metadata; `exact: false` when estimated, null when absent. */
  size?(req: SizeRequest): Promise<EntitySize | null>;

  /** rows matching the filtered request; an unknown filter field 422s here too, never widens the count. */
  count?(req: CountRequest): Promise<number>;

  /** group-by pushdown; undefined declines this one aggregate and Atlas folds the rows itself. */
  aggregate?(req: AggregateRequest): Promise<SourceRow[] | undefined>;

  /** per-column non-null and distinct counts from source-side COUNT / COUNT DISTINCT; null when it cannot. */
  cardinality?(req: CardinalityRequest): Promise<TableCardinality>;

  /** orphan rate of one candidate foreign key, from a source-side LEFT JOIN. */
  linkHitRate?(req: LinkHitRateRequest): Promise<LinkHitRate>;

  // #endregion
}
