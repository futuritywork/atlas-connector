// in-memory twin of the sql probe counting: the same values must yield the verdicts the sql
// probes' COUNT / COUNT DISTINCT / GROUP BY queries would, so key promotion sees one truth.
// grouping key is String(value); arrays include nulls; rows = the arrays' length.

import type { ColumnCountsProbe, GrainProbe, LinkProbe, TableColumnsProbe } from "../wire/schemas";
import type { AtlasType } from "../wire/vocabulary";
import { byteOrderCompare, decimalCompare } from "./apply-filters";

// protocol tuning — shared so no connector forks the near-unique band or the sample caps.
// ≥0.999 keeps near-unique business keys joinable with blemishes surfaced; below it the distinct
// count already refutes the key, so the repeats stay unenumerated
export const NEAR_UNIQUE_MIN_SHARE = 0.999;
export const DUP_SAMPLE_CAP = 100;
export const ORPHAN_SAMPLE_CAP = 20;

// multiplicity per String(value), nulls skipped — the in-memory GROUP BY
function groupCounts(values: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value == null) continue;
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function columnCounts(values: unknown[]): ColumnCountsProbe {
  const groups = groupCounts(values);
  let nonNull = 0;
  for (const count of groups.values()) nonNull += count;
  const distinct = groups.size;
  if (distinct === nonNull) {
    return { nonNull, distinct, duplicates: { valueCount: 0, maxMultiplicity: 1 } };
  }
  // below the near-unique band the distinct count already refutes the key: repeats stay unenumerated
  if (distinct < nonNull * NEAR_UNIQUE_MIN_SHARE) return { nonNull, distinct, duplicates: null };
  let valueCount = 0;
  let maxMultiplicity = 1;
  const duplicated: string[] = [];
  for (const [key, count] of groups) {
    if (count <= 1) continue;
    valueCount += 1;
    maxMultiplicity = Math.max(maxMultiplicity, count);
    duplicated.push(key);
  }
  // sorted, capped, then the empty spelling dropped — the sql sample query's exact order of operations
  const samples = duplicated
    .sort(byteOrderCompare)
    .slice(0, DUP_SAMPLE_CAP)
    .filter((key) => key !== "");
  return {
    nonNull,
    distinct,
    duplicates: { valueCount, maxMultiplicity, ...(samples.length > 0 ? { samples } : {}) },
  };
}

export function columnCountsFromValues(columns: Record<string, unknown[]>): TableColumnsProbe {
  const arrays = Object.values(columns);
  const rows = arrays[0]?.length ?? 0;
  const counts: Record<string, ColumnCountsProbe> = {};
  for (const [name, values] of Object.entries(columns)) {
    counts[name] = columnCounts(values);
  }
  return { rows, columns: counts };
}

// orphan = a non-null from-value with no match; the target collapses to distinct first so a
// duplicated to-value can neither deflate nor inflate the count
export function linkFromValues(fromValues: unknown[], toValues: unknown[]): LinkProbe {
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
  const orphanSamples = [...orphaned].sort(byteOrderCompare).slice(0, ORPHAN_SAMPLE_CAP);
  return {
    fromNonNull,
    orphanCount,
    orphanRate: fromNonNull > 0 ? orphanCount / fromNonNull : 0,
    orphanSamples,
  };
}

export function grainFromValues(values: unknown[]): GrainProbe {
  const groups = groupCounts(values);
  let nonNull = 0;
  for (const count of groups.values()) nonNull += count;
  return { rows: values.length, distinct: groups.size, nonNull };
}

// matches the sql sample's ORDER BY: numbers by magnitude, else bytes (chronological for iso text)
function sampleCompare(type: AtlasType): (a: string, b: string) => number {
  if (type !== "number" && type !== "decimal") return byteOrderCompare;
  return (a, b) => decimalCompare(a, b) ?? byteOrderCompare(a, b);
}

// same order as the sql sample: "" is dropped after the cap
export function sampleFromValues(values: unknown[], type: AtlasType, limit: number): string[] {
  const distinct = new Set<string>();
  for (const value of values) {
    if (value != null) distinct.add(String(value));
  }
  return [...distinct]
    .sort(sampleCompare(type))
    .slice(0, limit)
    .filter((value) => value !== "");
}
