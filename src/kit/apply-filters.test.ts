import { describe, expect, test } from "bun:test";
import type { AtlasType, Filter, SourceRow } from "../wire/vocabulary";
import { applyFilters, byteOrderCompare } from "./apply-filters";

// the monorepo conformance corpus scan_agree_facts fixture, embedded verbatim: every case below
// carries the verdict the sql lane answers, so a rest connector filtering in memory agrees exactly
const FACTS: SourceRow[] = [
  { id: "1", k: "Acme", qty: "1.5", amount: "10.250", day: "2026-03-05T10:00:00Z" },
  { id: "2", k: "acme", qty: "1.50", amount: "10.25", day: "2026-03-17T23:59:59Z" },
  { id: "3", k: "Beta ", qty: "9007199254740993", amount: "9007199254740993.12", day: "2026-04-01T00:00:00Z" },
  { id: "4", k: "beta", qty: 9007199254740992, amount: "-0.10", day: null },
  { id: "5", k: "café", qty: "7", amount: null, day: "2026-06-30T12:00:00Z" },
  { id: "6", k: "1.5", qty: null, amount: "2", day: "2027-01-01T00:00:00Z" },
  { id: "7", k: "1.50", qty: 2, amount: "2.00", day: "2026-07-01T00:00:00Z" },
  { id: "8", k: "", qty: "0", amount: "0.9", day: "2026-07-02T00:00:00Z" },
  { id: "9", k: null, qty: "-3.25", amount: "1000", day: "2026-07-03T00:00:00Z" },
];

const FACT_TYPES: Record<string, AtlasType> = {
  id: "string",
  k: "string",
  qty: "number",
  amount: "decimal",
  day: "datetime",
};

function ids(rows: SourceRow[]): string[] {
  return rows.map((row) => String(row.id));
}

function verdict(and: Filter[], or?: Filter[][]): string[] {
  return ids(applyFilters(FACTS, { and, or }, FACT_TYPES));
}

describe("corpus agreement — the sql lane's verdicts, in memory", () => {
  test("unfiltered full pull", () => {
    expect(verdict([])).toHaveLength(9);
  });

  test("string eq is case-sensitive byte equality", () => {
    expect(verdict([{ field: "k", op: "eq", value: "acme" }])).toEqual(["2"]);
  });

  test("a fractional spelling does not bridge on a string column", () => {
    expect(verdict([{ field: "k", op: "eq", value: "1.5" }])).toEqual(["6"]);
  });

  test("number eq collapses wire spellings of one number", () => {
    expect(verdict([{ field: "qty", op: "eq", value: 1.5 }])).toEqual(["1", "2"]);
  });

  test(">2^53 twins stay distinct under numeric compare", () => {
    expect(verdict([{ field: "qty", op: "eq", value: 9007199254740992 }])).toEqual(["4"]);
  });

  test("decimal eq matches every scale spelling exactly", () => {
    expect(verdict([{ field: "amount", op: "eq", value: "2" }])).toEqual(["6", "7"]);
  });

  test("decimal keeps digits a double already lost", () => {
    expect(verdict([{ field: "amount", op: "eq", value: "9007199254740993.12" }])).toEqual(["3"]);
  });

  test("numeric ranges order as numbers, not text", () => {
    expect(
      verdict([
        { field: "qty", op: "gt", value: 1 },
        { field: "qty", op: "lte", value: 7 },
      ]),
    ).toEqual(["1", "2", "5", "7"]);
  });

  test("an empty in matches nothing", () => {
    expect(verdict([{ field: "k", op: "in", values: [] }])).toEqual([]);
  });

  test("an empty nin drops nothing", () => {
    expect(verdict([{ field: "k", op: "nin", values: [] }])).toHaveLength(9);
  });

  test("nin keeps null cells", () => {
    expect(verdict([{ field: "k", op: "nin", values: ["Acme", "beta"] }])).toEqual([
      "2",
      "3",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
  });

  test("includes matches substrings case-sensitively", () => {
    expect(verdict([{ field: "k", op: "includes", value: "cme" }])).toEqual(["1", "2"]);
  });

  test("startswith matches a byte prefix", () => {
    expect(verdict([{ field: "k", op: "startswith", value: "Beta" }])).toEqual(["3"]);
  });

  test("isnull answers the null population", () => {
    expect(verdict([{ field: "qty", op: "isnull" }])).toEqual(["6"]);
  });

  test("notnull answers the populated rows, the empty string among them", () => {
    expect(verdict([{ field: "k", op: "notnull" }])).toHaveLength(8);
  });

  test("or-groups union under the and-filters", () => {
    expect(verdict([], [[{ field: "k", op: "eq", value: "Acme" }], [{ field: "qty", op: "gt", value: 6 }]])).toEqual([
      "1",
      "3",
      "4",
      "5",
    ]);
  });

  test("neq drops the match and every null cell", () => {
    expect(verdict([{ field: "k", op: "neq", value: "Acme" }])).toEqual(["2", "3", "4", "5", "6", "7", "8"]);
  });

  test("gt / gte split on the boundary value", () => {
    expect(verdict([{ field: "qty", op: "gt", value: 7 }])).toEqual(["3", "4"]);
    expect(verdict([{ field: "qty", op: "gte", value: 7 }])).toEqual(["3", "4", "5"]);
  });

  test("lt / lte split on the boundary value", () => {
    expect(verdict([{ field: "qty", op: "lt", value: 0 }])).toEqual(["9"]);
    expect(verdict([{ field: "qty", op: "lte", value: 0 }])).toEqual(["8", "9"]);
  });

  test("in matches any member byte-exactly", () => {
    expect(verdict([{ field: "k", op: "in", values: ["Acme", "café"] }])).toEqual(["1", "5"]);
  });

  test("filtered counts agree with the sql lane", () => {
    expect(verdict([{ field: "qty", op: "gt", value: 1 }])).toHaveLength(6);
    expect(verdict([], [[{ field: "k", op: "eq", value: "Acme" }], [{ field: "k", op: "eq", value: "acme" }]])).toHaveLength(2);
  });
});

describe("null handling", () => {
  test("a null filter value matches nothing on every value op", () => {
    for (const op of ["eq", "neq", "gt", "gte", "lt", "lte", "includes", "startswith"] as const) {
      expect(verdict([{ field: "k", op, value: null }])).toEqual([]);
    }
  });

  test("a null member of in is never-match, the rest still bind", () => {
    expect(verdict([{ field: "qty", op: "in", values: [null, 2] }])).toEqual(["7"]);
    expect(verdict([{ field: "qty", op: "in", values: [null] }])).toEqual([]);
  });

  test("a null member of nin is never-match, so it drops nothing extra", () => {
    expect(verdict([{ field: "k", op: "nin", values: [null, "Acme"] }])).toEqual(
      verdict([{ field: "k", op: "nin", values: ["Acme"] }]),
    );
  });

  test("a field absent from the row reads as null", () => {
    expect(verdict([{ field: "ghost", op: "isnull" }])).toHaveLength(9);
    expect(verdict([{ field: "ghost", op: "eq", value: "x" }])).toEqual([]);
    expect(verdict([{ field: "ghost", op: "nin", values: ["x"] }])).toHaveLength(9);
  });
});

describe("string and datetime ordering", () => {
  test("string ranges compare in byte order", () => {
    expect(verdict([{ field: "k", op: "gt", value: "beta" }])).toEqual(["5"]);
    expect(verdict([{ field: "k", op: "lt", value: "1.5" }])).toEqual(["8"]);
  });

  test("astral characters order by code point, not utf-16 unit", () => {
    const rows: SourceRow[] = [{ id: "1", k: "\u{1F600}" }];
    const matched = applyFilters(rows, { and: [{ field: "k", op: "gt", value: "\uFFFD" }] }, { k: "string" });
    expect(ids(matched)).toEqual(["1"]);
    expect(byteOrderCompare("\uFFFD", "\u{1F600}")).toBe(-1);
  });

  test("datetime ranges order chronologically over iso-z text", () => {
    expect(verdict([{ field: "day", op: "gte", value: "2026-07-01T00:00:00Z" }])).toEqual(["6", "7", "8", "9"]);
  });

  test("includes and startswith stringify numeric cells like col::text", () => {
    expect(verdict([{ field: "qty", op: "includes", value: "007" }])).toEqual(["3", "4"]);
    expect(verdict([{ field: "qty", op: "startswith", value: "-3" }])).toEqual(["9"]);
  });
});

describe("contains", () => {
  const TAGGED: SourceRow[] = [
    { id: "1", tags: '["red","blue"]' },
    { id: "2", tags: '["green"]' },
    { id: "3", tags: "[1,2,3]" },
    { id: "4", tags: null },
    { id: "5", tags: "red" },
  ];

  test("matches array elements crossed as json text", () => {
    expect(ids(applyFilters(TAGGED, { and: [{ field: "tags", op: "contains", value: "red" }] }))).toEqual(["1"]);
  });

  test("matches numeric elements across spellings", () => {
    expect(ids(applyFilters(TAGGED, { and: [{ field: "tags", op: "contains", value: 2 }] }))).toEqual(["3"]);
  });

  test("matches a real array on a pre-wire row", () => {
    const rows = [{ id: "1", tags: ["red", "blue"] }] as unknown as SourceRow[];
    expect(ids(applyFilters(rows, { and: [{ field: "tags", op: "contains", value: "blue" }] }))).toEqual(["1"]);
  });

  test("never matches substrings of a scalar", () => {
    expect(ids(applyFilters(TAGGED, { and: [{ field: "tags", op: "contains", value: "re" }] }))).toEqual([]);
  });
});

describe("shape of the filter set", () => {
  test("an absent or empty or-block adds no constraint", () => {
    expect(applyFilters(FACTS, { and: [] })).toHaveLength(9);
    expect(applyFilters(FACTS, { and: [], or: [] })).toHaveLength(9);
  });

  test("or-groups conjoin within and union across", () => {
    const or: Filter[][] = [
      [
        { field: "k", op: "eq", value: "Acme" },
        { field: "qty", op: "eq", value: 1.5 },
      ],
      [{ field: "k", op: "eq", value: "1.5" }],
    ];
    expect(verdict([], or)).toEqual(["1", "6"]);
  });

  test("the and-filters still gate every or-group", () => {
    expect(verdict([{ field: "k", op: "notnull" }], [[{ field: "qty", op: "lte", value: 0 }]])).toEqual(["8"]);
  });

  test("without fieldTypes, plain-decimal spellings bridge and everything else compares as bytes", () => {
    const rows = applyFilters(FACTS, { and: [{ field: "qty", op: "eq", value: "1.5" }] });
    expect(ids(rows)).toEqual(["1", "2"]);
    expect(ids(applyFilters(FACTS, { and: [{ field: "k", op: "eq", value: "café" }] }))).toEqual(["5"]);
  });
});
