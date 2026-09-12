import { describe, expect, test } from "bun:test";
import { cardinalityFromValues, columnTally, linkFromValues, ORPHAN_SAMPLE_CAP } from "./measure";

// the join-agreement corpus: these verdicts are what the sql lane's COUNT DISTINCT answers
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

describe("cardinalityFromValues: corpus agreement", () => {
  test("a fully unique key counts every value once", () => {
    expect(cardinalityFromValues({ k: AGREE_DIMS_UNIQUE_K })).toEqual({
      k: { nonNull: 7, distinct: 7 },
    });
  });

  test("byte-distinct casings never merge, so the dup fixture reads unique", () => {
    expect(cardinalityFromValues({ k: AGREE_DIMS_DUP_K }).k).toEqual({ nonNull: 3, distinct: 3 });
  });

  test("a repeated value lowers distinct below non-null", () => {
    expect(cardinalityFromValues({ k: N_DIMS_DUP_K }).k).toEqual({ nonNull: 2, distinct: 1 });
  });

  test(">2^53 twins stay distinct under string grouping", () => {
    expect(cardinalityFromValues({ k: N_DIMS_UNIQUE_K }).k?.distinct).toBe(3);
  });

  test("an all-null column measures as empty, not missing", () => {
    expect(cardinalityFromValues({ k: [null, null, undefined] }).k).toEqual({ nonNull: 0, distinct: 0 });
  });

  test("every named column is measured, and no column is invented", () => {
    const counts = cardinalityFromValues({ a: ["x", "y", null], b: [1, 1, 2] });
    expect(counts.a?.nonNull).toBe(2);
    expect(counts.b).toEqual({ nonNull: 3, distinct: 2 });
    expect(cardinalityFromValues({})).toEqual({});
  });
});

describe("columnTally", () => {
  test("folding batch by batch agrees with counting the whole column at once", () => {
    const tally = columnTally();
    for (const value of AGREE_FACTS_K) tally.add(value);
    expect(tally.counts()).toEqual(cardinalityFromValues({ k: AGREE_FACTS_K }).k!);
  });

  test("an untouched tally is the empty column", () => {
    expect(columnTally().counts()).toEqual({ nonNull: 0, distinct: 0 });
  });
});

describe("linkFromValues: corpus agreement", () => {
  test("facts→dims_unique measures the sql lane's orphans exactly", () => {
    const link = linkFromValues(AGREE_FACTS_K, AGREE_DIMS_UNIQUE_K);
    expect(link.fromNonNull).toBe(15);
    expect(link.orphanCount).toBe(10);
    expect(link.orphanRate).toBeCloseTo(10 / 15, 12);
    // distinct orphan spellings in byte order, the empty string included, as f.k::text sorts
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
