// the connector wire contract as Zod schemas; no .transform() (it breaks z.toJSONSchema codegen)

import { z } from "zod";
import { CONNECTOR_LIMITS } from "./limits";
import { AtlasType, AtlasValue, DateGrain, Filter, JoinField, UserSort } from "./vocabulary";

const deadlineShape = { timeoutMs: z.number().int().min(1) } as const;

// on every authed request; a connector holds none between calls
export const Credentials = z.record(z.string(), z.string());
export type Credentials = z.infer<typeof Credentials>;

const authedShape = { credentials: Credentials, ...deadlineShape } as const;
const WireAuthed = z.object(authedShape);

const SourceJoinFieldWire = JoinField.extend({ type: AtlasType });
const SourceJoinWire = z
  .object({
    fromTable: z.string(),
    toTable: z.string(),
    fromField: z.string(),
    toField: z.string(),
    fields: z.array(SourceJoinFieldWire),
  })
  .strict();
const CompiledSortWire = UserSort.extend({ collate: z.boolean().optional() });

export const SourceQueryWire = z
  .object({
    table: z.string(),
    and: z.array(Filter),
    or: z.array(z.array(Filter)).optional(),
    sort: z.array(CompiledSortWire),
    limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).optional(),
    fields: z.array(z.string()),
    joins: z.array(SourceJoinWire).optional(),
    fieldTypes: z.record(z.string(), AtlasType).optional(),
  })
  .strict();
export type SourceQueryWire = z.infer<typeof SourceQueryWire>;

// no avg: not pushable
const PushedMeasureFn = z.enum(["count", "sum", "min", "max", "count_distinct"]);
const GroupByWire = z.object({ field: z.string(), as: z.string(), grain: DateGrain.optional() }).strict();
const MeasureWire = z.object({ fn: PushedMeasureFn, field: z.string().optional(), as: z.string() }).strict();

export const AggregateSourceQueryWire = z
  .object({
    table: z.string(),
    and: z.array(Filter),
    or: z.array(z.array(Filter)).optional(),
    groupBy: z.array(GroupByWire),
    measures: z.array(MeasureWire),
    stringFields: z.array(z.string()),
    joins: z.array(SourceJoinWire).optional(),
    fieldTypes: z.record(z.string(), AtlasType).optional(),
  })
  .strict();
export type AggregateSourceQueryWire = z.infer<typeof AggregateSourceQueryWire>;

// dialect mode: Atlas sends the compiled SQL verbatim
export const DialectQueryBody = z.object({ sql: z.string(), params: z.array(AtlasValue) }).strict();
export type DialectQueryBody = z.infer<typeof DialectQueryBody>;

export const CheckRequest = WireAuthed;
export type CheckRequest = z.infer<typeof CheckRequest>;

export const CheckAnswer = z.object({ ok: z.literal(true) });
export type CheckAnswer = z.infer<typeof CheckAnswer>;

export const DiscoveryRequest = WireAuthed;
export type DiscoveryRequest = z.infer<typeof DiscoveryRequest>;

export const NativeQueryRequest = SourceQueryWire.extend(authedShape);
export type NativeQueryRequest = z.infer<typeof NativeQueryRequest>;

export const DialectQueryRequest = DialectQueryBody.extend(authedShape);
export type DialectQueryRequest = z.infer<typeof DialectQueryRequest>;

export const CountRequest = SourceQueryWire.pick({
  table: true,
  and: true,
  or: true,
  fieldTypes: true,
}).extend(authedShape);
export type CountRequest = z.infer<typeof CountRequest>;

const streamDeadlineShape = {
  idleTimeoutMs: z.number().int().min(1),
  maxTimeoutMs: z.number().int().min(1),
} as const;

export const NativeQueryStreamRequest = SourceQueryWire.extend(authedShape).extend(streamDeadlineShape);
export type NativeQueryStreamRequest = z.infer<typeof NativeQueryStreamRequest>;

export const DialectQueryStreamRequest = DialectQueryBody.extend(authedShape).extend(streamDeadlineShape);
export type DialectQueryStreamRequest = z.infer<typeof DialectQueryStreamRequest>;

// explicit group-row bound; more groups than limit means overflow, Atlas discards it
export const AggregateRequest = AggregateSourceQueryWire.extend({
  limit: z.number().int().min(1),
}).extend(authedShape);
export type AggregateRequest = z.infer<typeof AggregateRequest>;

export const ProbeColumnsRequest = z
  .object({ table: z.string(), columns: z.array(z.string()).min(1) })
  .extend(authedShape);
export type ProbeColumnsRequest = z.infer<typeof ProbeColumnsRequest>;

export const ProbeLinkRequest = z
  .object({
    fromTable: z.string(),
    fromColumn: z.string(),
    toTable: z.string(),
    toColumn: z.string(),
  })
  .extend(authedShape);
export type ProbeLinkRequest = z.infer<typeof ProbeLinkRequest>;

export const ProbeGrainRequest = z.object({ table: z.string(), column: z.string() }).extend(authedShape);
export type ProbeGrainRequest = z.infer<typeof ProbeGrainRequest>;

export const CountExactRequest = z.object({ table: z.string() }).extend(authedShape);
export type CountExactRequest = z.infer<typeof CountExactRequest>;

// answer: distinct non-null values as text, sorted (numbers by magnitude, else bytes), capped at limit, "" dropped after the cap
export const SampleKeyValuesRequest = z
  .object({
    table: z.string(),
    column: z.string(),
    type: AtlasType,
    limit: z.number().int().min(1),
  })
  .extend(authedShape);
export type SampleKeyValuesRequest = z.infer<typeof SampleKeyValuesRequest>;

// every JSON answer is a wrapped object, never a bare array

// decimals and integers >2^53 cross as digit-exact strings; json/array columns as JSON text; datetimes ISO-8601 UTC
export const SourceRowWire = z.record(z.string(), AtlasValue);

export const QueryAnswer = z.object({ rows: z.array(SourceRowWire) });
export type QueryAnswer = z.infer<typeof QueryAnswer>;

export const AggregateAnswer = z.object({ rows: z.array(SourceRowWire) });
export type AggregateAnswer = z.infer<typeof AggregateAnswer>;

export const CountAnswer = z.object({ count: z.number().int() });
export type CountAnswer = z.infer<typeof CountAnswer>;

// null count sits inside the wrapper, never a bare null body
export const CountExactAnswer = z.object({ count: z.number().int().nullable() });
export type CountExactAnswer = z.infer<typeof CountExactAnswer>;

export const SampleKeyValuesAnswer = z.object({ values: z.array(z.string()) });
export type SampleKeyValuesAnswer = z.infer<typeof SampleKeyValuesAnswer>;

export const ForeignKeyWire = z
  .object({
    field: z.string(),
    targetTable: z.string(),
    targetField: z.string(),
  })
  .strict();
export const FieldStatsWire = z
  .object({
    nullPercent: z.number().optional(),
    distinctCount: z.number().int(),
    min: z.string().optional(),
    max: z.string().optional(),
  })
  .strict();
export const DiscoveredFieldWire = z
  .object({
    name: z.string(),
    sourceColumn: z.string(),
    type: AtlasType,
    nullable: z.boolean(),
    unique: z.boolean(),
    samples: z.array(AtlasValue),
    sourceDescription: z.string(),
    stats: FieldStatsWire.optional(),
    filterable: z.boolean().optional(),
    groupable: z.boolean().optional(),
    aggregatable: z.boolean().optional(),
  })
  .strict();
export const DiscoveredTableWire = z
  .object({
    name: z.string(),
    sourceDescription: z.string(),
    rowCount: z.number().int().optional(),
    storesRows: z.boolean(),
    primaryKey: z.array(z.string()),
    foreignKeys: z.array(ForeignKeyWire),
    fields: z.array(DiscoveredFieldWire),
  })
  .strict();
export const DiscoveryAnswer = z.object({
  tables: z.array(DiscoveredTableWire),
  warnings: z.array(z.string()).optional(),
});
export type DiscoveryAnswer = z.infer<typeof DiscoveryAnswer>;

export const ColumnDuplicatesWire = z
  .object({
    valueCount: z.number().int(),
    maxMultiplicity: z.number().int(),
    samples: z.array(z.string()).optional(),
  })
  .strict();
export const ColumnCountsProbeWire = z
  .object({
    nonNull: z.number().int(),
    distinct: z.number().int(),
    duplicates: ColumnDuplicatesWire.nullable(),
  })
  .strict();
// columns as a record on the wire; a Map JSON-serializes to {} silently
export const TableColumnsProbeWire = z
  .object({
    rows: z.number().int(),
    columns: z.record(z.string(), ColumnCountsProbeWire),
  })
  .strict();
export const LinkProbeWire = z
  .object({
    fromNonNull: z.number().int(),
    orphanCount: z.number().int(),
    orphanRate: z.number(),
    orphanSamples: z.array(z.string()),
  })
  .strict();
export const GrainProbeWire = z
  .object({
    rows: z.number().int(),
    distinct: z.number().int(),
    nonNull: z.number().int(),
  })
  .strict();

// connector-side names for the answer shapes — z.infer so they cannot drift from the wire
export type DiscoveredTable = z.infer<typeof DiscoveredTableWire>;
export type DiscoveredField = z.infer<typeof DiscoveredFieldWire>;
export type TableColumnsProbe = z.infer<typeof TableColumnsProbeWire>;
export type ColumnCountsProbe = z.infer<typeof ColumnCountsProbeWire>;
export type ColumnDuplicates = z.infer<typeof ColumnDuplicatesWire>;
export type LinkProbe = z.infer<typeof LinkProbeWire>;
export type GrainProbe = z.infer<typeof GrainProbeWire>;

export const WireError = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type WireError = z.infer<typeof WireError>;

// {end:1} or {error} terminates; a close without either is a truncated stream, the reader must fail
export const StreamLine = z.union([
  z.object({ rows: z.array(SourceRowWire).min(1).max(CONNECTOR_LIMITS.rowsPerBatch) }),
  z.object({ ping: z.literal(1) }),
  z.object({ error: WireError.shape.error }),
  z.object({ end: z.literal(1) }),
]);
export type StreamLine = z.infer<typeof StreamLine>;
