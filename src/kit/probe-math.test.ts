import { describe, expect, test } from "bun:test";
import {
  columnCountsFromValues,
  DUP_SAMPLE_CAP,
  grainFromValues,
  linkFromValues,
  NEAR_UNIQUE_MIN_SHARE,
  ORPHAN_SAMPLE_CAP,
  sampleFromValues,
} from "./probe-math";

// the monorepo conformance corpus join-agreement fixtures, embedded verbatim: the verdicts
// asserted below are what the sql probes' COUNT / COUNT DISTINCT queries answer on the same data
const AGREE_FACTS_K = [
  "Acme",
  "acme",
  "Beta ",
  "beta",
  "Gamma ",
  "İstanbul",
  "istanbul",
  "café",
  "1.5",
  "1.50",
  "strasse",
  "straße",
  "ghost",
  "",
  "   ",
  null,
];
const AGREE_DIMS_UNIQUE_K = ["Acme", "Beta", "Gamma", "İstanbul", "café", "1.5", "straße"];
const AGREE_DIMS_DUP_K = ["Acme", "acme", "Beta"];
const N_FACTS_K = ["9007199254740993", "9007199254740992", "7", null];
const N_DIMS_UNIQUE_K = ["9007199254740993", "9007199254740992", "3"];
const N_DIMS_DUP_K = ["7", "7"];

describe("columnCountsFromValues — corpus agreement", () => {
  test("a fully unique key answers the clean-key shape", () => {
    expect(columnCountsFromValues({ k: AGREE_DIMS_UNIQUE_K })).toEqual({
      rows: 7,
      columns: { k: { nonNull: 7, distinct: 7, duplicates: { valueCount: 0, maxMultiplicity: 1 } } },
    });
  });

  test("byte-distinct casings never merge, so the dup fixture still reads unique", () => {
    const { columns } = columnCountsFromValues({ k: AGREE_DIMS_DUP_K });
    expect(columns.k).toEqual({ nonNull: 3, distinct: 3, duplicates: { valueCount: 0, maxMultiplicity: 1 } });
  });

  test("a duplicated key below the near-unique band leaves the repeats unenumerated", () => {
    const { columns } = columnCountsFromValues({ k: N_DIMS_DUP_K });
    expect(columns.k).toEqual({ nonNull: 2, distinct: 1, duplicates: null });
  });

  test(">2^53 twins stay distinct under string grouping", () => {
    const { columns } = columnCountsFromValues({ k: N_DIMS_UNIQUE_K });
    expect(columns.k?.distinct).toBe(3);
  });

  test("an all-null column measures as empty, not missing", () => {
    const { columns } = columnCountsFromValues({ k: [null, null, undefined] });
    expect(columns.k).toEqual({ nonNull: 0, distinct: 0, duplicates: { valueCount: 0, maxMultiplicity: 1 } });
  });

  test("rows is the arrays' length and every named column is measured", () => {
    const probe = columnCountsFromValues({ a: ["x", "y", null], b: [1, 1, 2] });
    expect(probe.rows).toBe(3);
    expect(probe.columns.a?.nonNull).toBe(2);
    expect(probe.columns.b?.nonNull).toBe(3);
    expect(columnCountsFromValues({})).toEqual({ rows: 0, columns: {} });
  });
});

describe("columnCountsFromValues — the near-unique band", () => {
  // 998 uniques + one duplicated pair: distinct/nonNull sits exactly on the 0.999 floor
  test("the floor itself enumerates the blemishes", () => {
    const values = [...Array.from({ length: 998 }, (_, i) => `u${i}`), "dup", "dup"];
    const { columns } = columnCountsFromValues({ k: values });
    expect(columns.k).toEqual({
      nonNull: 1000,
      distinct: 999,
      duplicates: { valueCount: 1, maxMultiplicity: 2, samples: ["dup"] },
    });
  });

  test("one blemish more falls below the floor and answers null", () => {
    const values = [...Array.from({ length: 996 }, (_, i) => `u${i}`), "d1", "d1", "d2", "d2"];
    const { columns } = columnCountsFromValues({ k: values });
    expect(columns.k?.distinct).toBeLessThan((columns.k?.nonNull ?? 0) * NEAR_UNIQUE_MIN_SHARE);
    expect(columns.k?.duplicates).toBeNull();
  });

  test("samples sort in byte order and cap at DUP_SAMPLE_CAP", () => {
    const uniques = Array.from({ length: 101_000 }, (_, i) => `u${String(i).padStart(6, "0")}`);
    const dups = Array.from({ length: 101 }, (_, i) => `d${String(i).padStart(3, "0")}`);
    const { columns } = columnCountsFromValues({ k: [...uniques, ...dups, ...dups] });
    expect(columns.k?.duplicates?.valueCount).toBe(101);
    expect(columns.k?.duplicates?.maxMultiplicity).toBe(2);
    expect(columns.k?.duplicates?.samples).toEqual(dups.slice(0, DUP_SAMPLE_CAP));
  });

  test("an empty-string blemish is counted but never sampled", () => {
    const values = [...Array.from({ length: 998 }, (_, i) => `u${i}`), "", ""];
    const { columns } = columnCountsFromValues({ k: values });
    expect(columns.k?.duplicates).toEqual({ valueCount: 1, maxMultiplicity: 2 });
  });

  test("maxMultiplicity reports the worst repeat", () => {
    const values = [...Array.from({ length: 2996 }, (_, i) => `u${i}`), "d", "d", "d", "e", "e"];
    const { columns } = columnCountsFromValues({ k: values });
    expect(columns.k?.duplicates).toEqual({ valueCount: 2, maxMultiplicity: 3, samples: ["d", "e"] });
  });
});

describe("linkFromValues — corpus agreement", () => {
  test("facts→dims_unique measures the sql lane's orphans exactly", () => {
    const link = linkFromValues(AGREE_FACTS_K, AGREE_DIMS_UNIQUE_K);
    expect(link.fromNonNull).toBe(15);
    expect(link.orphanCount).toBe(10);
    expect(link.orphanRate).toBeCloseTo(10 / 15, 12);
    // distinct orphan spellings in byte order, the empty string included, exactly as f.k::text sorts
    expect(link.orphanSamples).toEqual([
      "",
      "   ",
      "1.50",
      "Beta ",
      "Gamma ",
      "acme",
      "beta",
      "ghost",
      "istanbul",
      "strasse",
    ]);
  });

  test("n_facts→n_dims_unique keeps >2^53 twins distinct", () => {
    const link = linkFromValues(N_FACTS_K, N_DIMS_UNIQUE_K);
    expect(link).toEqual({ fromNonNull: 3, orphanCount: 1, orphanRate: 1 / 3, orphanSamples: ["7"] });
  });

  test("a duplicated target value neither deflates nor inflates the count", () => {
    const link = linkFromValues(["x", "y"], ["x", "x"]);
    expect(link.fromNonNull).toBe(2);
    expect(link.orphanCount).toBe(1);
    expect(link.orphanSamples).toEqual(["y"]);
  });

  test("orphan samples are distinct spellings, capped at ORPHAN_SAMPLE_CAP", () => {
    const from = Array.from({ length: 25 }, (_, i) => `o${String(i).padStart(2, "0")}`);
    const link = linkFromValues([...from, ...from], []);
    expect(link.orphanCount).toBe(50);
    expect(link.orphanSamples).toEqual(from.slice(0, ORPHAN_SAMPLE_CAP));
  });

  test("an empty from side answers rate zero, never NaN", () => {
    expect(linkFromValues([null, null], ["x"])).toEqual({
      fromNonNull: 0,
      orphanCount: 0,
      orphanRate: 0,
      orphanSamples: [],
    });
  });
});

describe("grainFromValues", () => {
  test("rows beside distinct and non-null, corpus verdicts", () => {
    expect(grainFromValues(AGREE_FACTS_K)).toEqual({ rows: 16, distinct: 15, nonNull: 15 });
    expect(grainFromValues(N_DIMS_DUP_K)).toEqual({ rows: 2, distinct: 1, nonNull: 2 });
  });

  test("grouping key is String(value), so spellings of one text collapse", () => {
    expect(grainFromValues([1, "1", true, "true", null])).toEqual({ rows: 5, distinct: 2, nonNull: 4 });
  });

  test("grain agrees with the column probe on the same values", () => {
    const { columns } = columnCountsFromValues({ k: AGREE_DIMS_UNIQUE_K });
    const grain = grainFromValues(AGREE_DIMS_UNIQUE_K);
    expect(grain.distinct).toBe(columns.k?.distinct ?? -1);
    expect(grain.nonNull).toBe(columns.k?.nonNull ?? -1);
  });
});

describe("sampleFromValues", () => {
  test("numbers order by magnitude, not by bytes", () => {
    expect(sampleFromValues([10, 2, 10, null], "number", 5)).toEqual(["2", "10"]);
    expect(sampleFromValues(["10", "2"], "string", 5)).toEqual(["10", "2"]);
  });

  test("decimals past 2^53 stay distinct and ordered digit-exact", () => {
    const big = ["9007199254740993", "9007199254740992"];
    expect(sampleFromValues(big, "decimal", 5)).toEqual(["9007199254740992", "9007199254740993"]);
  });

  test("iso datetimes order chronologically as bytes", () => {
    const stamps = ["2026-01-02T00:00:00", "2026-01-01T23:59:59"];
    expect(sampleFromValues(stamps, "datetime", 5)).toEqual([
      "2026-01-01T23:59:59",
      "2026-01-02T00:00:00",
    ]);
  });

  test("the limit is taken before the empty spelling is dropped, as the sql query does", () => {
    expect(sampleFromValues(["", "a", "b"], "string", 2)).toEqual(["a"]);
  });
});
