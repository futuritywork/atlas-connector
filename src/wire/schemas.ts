// the connector wire contract as zod schemas; no .transform() (it breaks z.toJSONSchema codegen)

import { z } from "zod";
import { CONNECTOR_LIMITS } from "./limits";
import { AtlasType, AtlasValue, DateGrain, Filter, JoinField, UserSort } from "./vocabulary";

const deadlineShape = { timeoutMs: z.number().int().min(1) } as const;

const streamDeadlineShape = {
  idleTimeoutMs: z.number().int().min(1),
  maxTimeoutMs: z.number().int().min(1),
} as const;

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

export const CheckRequest = WireAuthed;
export type CheckRequest = z.infer<typeof CheckRequest>;

export const CheckAnswer = z.object({ ok: z.literal(true) });
export type CheckAnswer = z.infer<typeof CheckAnswer>;

export const DiscoveryRequest = WireAuthed;
export type DiscoveryRequest = z.infer<typeof DiscoveryRequest>;

export const NativeQueryRequest = SourceQueryWire.extend(authedShape);
export type NativeQueryRequest = z.infer<typeof NativeQueryRequest>;

export const NativeQueryStreamRequest = SourceQueryWire.extend(authedShape).extend(streamDeadlineShape);
export type NativeQueryStreamRequest = z.infer<typeof NativeQueryStreamRequest>;

export const CountRequest = SourceQueryWire.pick({
  table: true,
  and: true,
  or: true,
  fieldTypes: true,
}).extend(authedShape);
export type CountRequest = z.infer<typeof CountRequest>;

// explicit group-row bound; more groups than limit is an overflow
export const AggregateRequest = AggregateSourceQueryWire.extend({
  limit: z.number().int().min(1),
}).extend(authedShape);
export type AggregateRequest = z.infer<typeof AggregateRequest>;

export const CardinalityRequest = z
  .object({ table: z.string(), columns: z.array(z.string()).min(1) })
  .extend(authedShape);
export type CardinalityRequest = z.infer<typeof CardinalityRequest>;

export const LinkHitRateRequest = z
  .object({
    fromTable: z.string(),
    fromColumn: z.string(),
    toTable: z.string(),
    toColumn: z.string(),
  })
  .extend(authedShape);
export type LinkHitRateRequest = z.infer<typeof LinkHitRateRequest>;

export const SizeRequest = z.object({ table: z.string() }).extend(authedShape);
export type SizeRequest = z.infer<typeof SizeRequest>;

// every json answer is a wrapped object, never a bare array

// decimals and ints past 2^53 cross as digit-exact strings; json as json text, datetimes iso-8601 utc
export const SourceRowWire = z.record(z.string(), AtlasValue);

export const AggregateAnswer = z.object({ rows: z.array(SourceRowWire) });
export type AggregateAnswer = z.infer<typeof AggregateAnswer>;

export const CountAnswer = z.object({ count: z.number().int() });
export type CountAnswer = z.infer<typeof CountAnswer>;

// the whole table's row count; exact false when the upstream only estimates
export const SizeWire = z.object({ rows: z.number().int().min(0), exact: z.boolean() }).strict();
export type EntitySize = z.infer<typeof SizeWire>;

// null size sits inside the wrapper, never a bare null body
export const SizeAnswer = z.object({ size: SizeWire.nullable() });
export type SizeAnswer = z.infer<typeof SizeAnswer>;

// a declared edge, enforced upstream or not
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
    sourceColumn: z.string(), // the upstream spelling; equal to name unless the connector renames it
    type: AtlasType,
    nullable: z.boolean(),
    unique: z.boolean(), // a real upstream UNIQUE/PK constraint, never sampled distinctness
    samples: z.array(AtlasValue),
    sourceDescription: z.string(),
    stats: FieldStatsWire.optional(), // omit rather than guess
    filterable: z.boolean().optional(), // absent means yes
    groupable: z.boolean().optional(),
    aggregatable: z.boolean().optional(),
  })
  .strict();

export const DiscoveredTableWire = z
  .object({
    name: z.string(),
    sourceDescription: z.string(),
    rowCount: z.number().int().optional(), // set it only when the upstream total is free
    storesRows: z.boolean(), // false for an endpoint that only computes
    primaryKey: z.array(z.string()), // [] declares no key, not that you did not look
    foreignKeys: z.array(ForeignKeyWire),
    fields: z.array(DiscoveredFieldWire), // one left out can never be filtered, sorted or projected
  })
  .strict();

export const DiscoveryAnswer = z.object({
  tables: z.array(DiscoveredTableWire),
  warnings: z.array(z.string()).optional(), // non-fatal notes shown to the tenant
});
export type DiscoveryAnswer = z.infer<typeof DiscoveryAnswer>;

export const ColumnCardinalityWire = z
  .object({ nonNull: z.number().int(), distinct: z.number().int() })
  .strict();

// null for a column the source cannot count distinctly
export const CardinalityWire = z.record(z.string(), ColumnCardinalityWire.nullable());

export const CardinalityAnswer = z.object({ columns: CardinalityWire });
export type CardinalityAnswer = z.infer<typeof CardinalityAnswer>;

export const LinkHitRateWire = z
  .object({
    fromNonNull: z.number().int(),
    orphanCount: z.number().int(),
    orphanRate: z.number(),
    orphanSamples: z.array(z.string()),
  })
  .strict();

// connector-side names, z.infer so they cannot drift from the wire
export type DiscoveredTable = z.infer<typeof DiscoveredTableWire>;
export type DiscoveredField = z.infer<typeof DiscoveredFieldWire>;
export type ColumnCardinality = z.infer<typeof ColumnCardinalityWire>;
export type TableCardinality = z.infer<typeof CardinalityWire>;
export type LinkHitRate = z.infer<typeof LinkHitRateWire>;

export const WireError = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type WireError = z.infer<typeof WireError>;

// what the connector applied upstream; false leaves that part to the host
export const ServedWire = z
  .object({
    filters: z.boolean(), // true only when every and/or predicate ran upstream with atlas semantics
    sort: z.boolean(),
    window: z.boolean(), // offset and limit applied, and no row exists beyond them
  })
  .strict();
export type Served = z.infer<typeof ServedWire>;

// {served} leads, {end:1} or {error} terminates; a close without either is a truncated stream
// every branch is strict, so a line mixing kinds fails instead of matching the first
export const StreamLine = z.union([
  z.object({ served: ServedWire }).strict(),
  z.object({ rows: z.array(SourceRowWire).min(1).max(CONNECTOR_LIMITS.rowsPerBatch) }).strict(),
  z.object({ ping: z.literal(1) }).strict(),
  z.object({ error: WireError.shape.error }).strict(),
  z.object({ end: z.literal(1) }).strict(),
]);
export type StreamLine = z.infer<typeof StreamLine>;
