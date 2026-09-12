// in-memory twins of the sql cardinality and link queries: same verdicts as COUNT DISTINCT and LEFT JOIN
// values group by String(value), nulls skipped

import type { ColumnCardinality, LinkHitRate, TableCardinality } from "../wire/schemas";
import { byteOrderCompare } from "./apply-filters";

export const ORPHAN_SAMPLE_CAP = 20;

/** folds one column batch by batch, so a caller holds O(distinct) instead of the whole column. */
export function columnTally(): { add(value: unknown): void; counts(): ColumnCardinality } {
  const groups = new Map<string, number>();
  let nonNull = 0;
  return {
    add(value: unknown): void {
      if (value == null) return;
      nonNull += 1;
      const key = String(value);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    },
    counts(): ColumnCardinality {
      return { nonNull, distinct: groups.size };
    },
  };
}

export function cardinalityFromValues(columns: Record<string, unknown[]>): TableCardinality {
  const counts: TableCardinality = {};
  for (const [name, values] of Object.entries(columns)) {
    const tally = columnTally();
    for (const value of values) tally.add(value);
    counts[name] = tally.counts();
  }
  return counts;
}

/** orphan = a non-null from-value with no match; a distinct target set keeps duplicates from skewing it. */
export function linkFromValues(fromValues: unknown[], toValues: unknown[]): LinkHitRate {
  const targets = new Set<string>();
  for (const value of toValues) {
    if (value != null) targets.add(String(value));
  }
  let fromNonNull = 0;
  let orphanCount = 0;
  const orphaned = new Set<string>();
  for (const value of fromValues) {
    if (value == null) continue;
    fromNonNull += 1;
    const key = String(value);
    if (targets.has(key)) continue;
    orphanCount += 1;
    orphaned.add(key);
  }
  const orphanRate = fromNonNull > 0 ? orphanCount / fromNonNull : 0;
  const orphanSamples = [...orphaned].sort(byteOrderCompare).slice(0, ORPHAN_SAMPLE_CAP);
  return { fromNonNull, orphanCount, orphanRate, orphanSamples };
}
