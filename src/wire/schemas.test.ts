import { describe, expect, test } from "bun:test";
import { CONNECTOR_LIMITS } from "./limits";
import {
  AggregateRequest,
  CheckAnswer,
  CheckRequest,
  CountAnswer,
  CountExactAnswer,
  CountRequest,
  DiscoveryAnswer,
  NativeQueryRequest,
  NativeQueryStreamRequest,
  QueryAnswer,
  SampleKeyValuesAnswer,
  SampleKeyValuesRequest,
  SourceQueryWire,
  StreamLine,
  TableColumnsProbeWire,
} from "./schemas";

test("CONNECTOR_LIMITS values are pinned", () => {
  expect(CONNECTOR_LIMITS).toEqual({
    docBytes: 65536,
    jsonAnswerBytes: 33554432,
    ndjsonLineBytes: 16777216,
    rowsPerBatch: 5000,
    heartbeatIntervalMs: 10000,
  });
});

const fullQuery = {
  table: "companies",
  and: [{ field: "name", op: "includes", value: "corp" }],
  or: [[{ field: "id", op: "in", values: [1, 2] }], [{ field: "owner", op: "isnull" }]],
  sort: [{ field: "name", dir: "asc", collate: true }],
  limit: 100,
  offset: 20,
  fields: ["id", "name"],
  joins: [
    {
      fromTable: "companies",
      toTable: "owners",
      fromField: "owner_id",
      toField: "id",
      fields: [{ field: "email", as: "owner_email", type: "string" }],
    },
  ],
  fieldTypes: { id: "number", name: "string" },
};

describe("SourceQueryWire", () => {
  test("a full query round-trips unchanged", () => {
    const parsed = SourceQueryWire.parse(fullQuery);
    expect(parsed).toEqual(fullQuery as SourceQueryWire);
  });

  test("unknown keys reject at every strict level", () => {
    expect(SourceQueryWire.safeParse({ ...fullQuery, distinct: true }).success).toBe(false);
    const badJoin = { ...fullQuery, joins: [{ ...fullQuery.joins[0]!, how: "left" }] };
    expect(SourceQueryWire.safeParse(badJoin).success).toBe(false);
  });

  test("limit/offset bounds hold", () => {
    expect(SourceQueryWire.safeParse({ ...fullQuery, limit: 0 }).success).toBe(false);
    expect(SourceQueryWire.safeParse({ ...fullQuery, offset: -1 }).success).toBe(false);
  });
});

const authed = { credentials: { apiKey: "k" }, timeoutMs: 5000 };

describe("requests carry deadlines and the tenant's credentials", () => {
  test("NativeQueryRequest = query + credentials + timeoutMs", () => {
    expect(NativeQueryRequest.safeParse({ ...fullQuery, ...authed }).success).toBe(true);
    expect(NativeQueryRequest.safeParse(fullQuery).success).toBe(false);
    expect(NativeQueryRequest.safeParse({ ...fullQuery, ...authed, timeoutMs: 0 }).success).toBe(false);
  });

  test("credentials are required, string-valued, and never absent", () => {
    const { credentials: _dropped, ...credless } = authed;
    expect(NativeQueryRequest.safeParse({ ...fullQuery, ...credless }).success).toBe(false);
    expect(NativeQueryRequest.safeParse({ ...fullQuery, ...authed, credentials: {} }).success).toBe(true);
    expect(
      NativeQueryRequest.safeParse({ ...fullQuery, ...authed, credentials: { port: 5432 } }).success,
    ).toBe(false);
  });

  test("CheckRequest is credentials and a deadline, nothing else to leak", () => {
    expect(CheckRequest.safeParse(authed).success).toBe(true);
    expect(CheckRequest.safeParse({ timeoutMs: 5000 }).success).toBe(false);
    expect(CheckAnswer.safeParse({ ok: true }).success).toBe(true);
    expect(CheckAnswer.safeParse({ ok: false }).success).toBe(false);
  });

  test("stream requests also require idle + max deadlines", () => {
    const base = { ...fullQuery, ...authed };
    expect(NativeQueryStreamRequest.safeParse(base).success).toBe(false);
    expect(
      NativeQueryStreamRequest.safeParse({ ...base, idleTimeoutMs: 30_000, maxTimeoutMs: 600_000 }).success,
    ).toBe(true);
  });

  test("CountRequest takes filters only", () => {
    const count = { table: "companies", and: [], ...authed };
    expect(CountRequest.safeParse(count).success).toBe(true);
    expect(CountRequest.safeParse({ ...count, sort: [] }).success).toBe(false);
  });

  test("SampleKeyValuesRequest binds a column type", () => {
    const sample = { table: "t", column: "id", type: "number", limit: 50, ...authed };
    expect(SampleKeyValuesRequest.safeParse(sample).success).toBe(true);
    expect(SampleKeyValuesRequest.safeParse({ ...sample, type: "uuid" }).success).toBe(false);
  });
});

describe("AggregateRequest", () => {
  const agg = {
    table: "orders",
    and: [],
    groupBy: [{ field: "created_at", as: "month", grain: "month" }],
    measures: [{ fn: "sum", field: "total", as: "revenue" }],
    stringFields: [],
    limit: 1000,
    credentials: { apiKey: "k" },
    timeoutMs: 5000,
  };

  test("parses with an explicit group-row bound", () => {
    expect(AggregateRequest.safeParse(agg).success).toBe(true);
    expect(AggregateRequest.safeParse({ ...agg, limit: undefined }).success).toBe(false);
  });

  test("avg is not pushable and week is not a grain", () => {
    expect(
      AggregateRequest.safeParse({ ...agg, measures: [{ fn: "avg", field: "total", as: "a" }] }).success,
    ).toBe(false);
    expect(
      AggregateRequest.safeParse({ ...agg, groupBy: [{ field: "created_at", as: "w", grain: "week" }] }).success,
    ).toBe(false);
  });
});

describe("answers are wrapped objects, never bare arrays", () => {
  test("QueryAnswer wraps rows", () => {
    expect(QueryAnswer.safeParse({ rows: [{ id: 1, name: "acme", gone: null }] }).success).toBe(true);
    expect(QueryAnswer.safeParse([{ id: 1 }]).success).toBe(false);
  });

  test("counts are ints; null exact count sits inside the wrapper", () => {
    expect(CountAnswer.safeParse({ count: 12 }).success).toBe(true);
    expect(CountAnswer.safeParse({ count: 1.5 }).success).toBe(false);
    expect(CountExactAnswer.safeParse({ count: null }).success).toBe(true);
    expect(CountExactAnswer.safeParse(null).success).toBe(false);
  });

  test("sample key values cross as text", () => {
    expect(SampleKeyValuesAnswer.safeParse({ values: ["1", "2"] }).success).toBe(true);
    expect(SampleKeyValuesAnswer.safeParse({ values: [1, 2] }).success).toBe(false);
  });
});

describe("DiscoveryAnswer", () => {
  const table = {
    name: "companies",
    sourceDescription: "Accounts.",
    rowCount: 42,
    storesRows: true,
    primaryKey: ["id"],
    foreignKeys: [{ field: "owner_id", targetTable: "owners", targetField: "id" }],
    fields: [
      {
        name: "id",
        sourceColumn: "id",
        type: "number",
        nullable: false,
        unique: true,
        samples: [1, 2, 3],
        sourceDescription: "pk",
        stats: { distinctCount: 42, min: "1", max: "42" },
        filterable: true,
      },
    ],
  };

  test("a full table round-trips unchanged", () => {
    const answer = { tables: [table], warnings: ["fk owners.id unverified"] };
    expect(DiscoveryAnswer.parse(answer)).toEqual(answer as DiscoveryAnswer);
  });

  test("unknown field keys reject rather than strip", () => {
    const bad = { tables: [{ ...table, fields: [{ ...table.fields[0]!, indexed: true }] }] };
    expect(DiscoveryAnswer.safeParse(bad).success).toBe(false);
  });
});

describe("probe answers", () => {
  test("columns cross as a record, duplicates nullable", () => {
    const probe = {
      rows: 100,
      columns: {
        id: { nonNull: 100, distinct: 100, duplicates: null },
        email: { nonNull: 90, distinct: 88, duplicates: { valueCount: 2, maxMultiplicity: 2, samples: ["a@b"] } },
      },
    };
    expect(TableColumnsProbeWire.safeParse(probe).success).toBe(true);
    expect(TableColumnsProbeWire.safeParse({ ...probe, columns: new Map() }).success).toBe(false);
  });
});

describe("StreamLine", () => {
  test("the four variants parse", () => {
    expect(StreamLine.safeParse({ rows: [{ id: 1 }] }).success).toBe(true);
    expect(StreamLine.safeParse({ ping: 1 }).success).toBe(true);
    expect(StreamLine.safeParse({ error: { code: "timeout", message: "query timed out" } }).success).toBe(true);
    expect(StreamLine.safeParse({ end: 1 }).success).toBe(true);
  });

  test("empty and oversized batches reject", () => {
    expect(StreamLine.safeParse({ rows: [] }).success).toBe(false);
    const oversized = Array.from({ length: CONNECTOR_LIMITS.rowsPerBatch + 1 }, () => ({ id: 1 }));
    expect(StreamLine.safeParse({ rows: oversized }).success).toBe(false);
    expect(StreamLine.safeParse({ rows: oversized.slice(1) }).success).toBe(true);
  });

  test("literal markers admit no other values", () => {
    expect(StreamLine.safeParse({ ping: 2 }).success).toBe(false);
    expect(StreamLine.safeParse({ end: 0 }).success).toBe(false);
    expect(StreamLine.safeParse({}).success).toBe(false);
  });
});
