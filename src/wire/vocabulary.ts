// sdk-owned copies of the atlas vocabulary, structurally identical to the monorepo's
// @futurity/schemas originals; the monorepo's wire-agreement test makes drift loud

import { z } from "zod";

export const ATLAS_TYPES = [
  "string",
  "number",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "json",
  "array",
  "reference",
] as const;

export const AtlasType = z.enum(ATLAS_TYPES);
export type AtlasType = z.infer<typeof AtlasType>;

export const AtlasValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type AtlasValue = z.infer<typeof AtlasValue>;

// AtlasValue stays broad because generic wire schemas do not have the field's declared type.
// These schemas validate values once that catalog context is available.
const PLAIN_DECIMAL_TEXT = /^[+-]?\d+(?:\.\d+)?$/;

export const AtlasNumeric = z.union([
  z.string().regex(PLAIN_DECIMAL_TEXT),
  z
    .number()
    .refine(
      (value) =>
        PLAIN_DECIMAL_TEXT.test(String(value)) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value)),
    ),
]);
export const AtlasBoolean = z.boolean();
export const AtlasDate = z.iso.date();
// SQL connectors emit zone-less UTC datetimes; REST connectors may emit canonical Z datetimes.
export const AtlasDatetime = z.iso.datetime({ local: true });

// the wire-legal row a connector returns (narrower than a raw driver row: scalars only)
export type SourceRow = Record<string, AtlasValue>;

const COMPARATOR_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;

// order is load-bearing: op lists derived from OPS must stay stable across copies
export const OPS = [
  ...COMPARATOR_OPS,
  "in", // is this field's value one of <value>? (where <value> is an array)
  "nin", // is this field's value NOT one of <value>?
  "contains", // is <value> an element of the field's array?
  "includes", // does the field's string include <value>
  "startswith", // does the field's string start with <value>
  "isnull",
  "notnull",
] as const;

export const Op = z.enum(OPS);
export type Op = z.infer<typeof Op>;

// value ops carry a scalar; member ops carry an array; nullary ops carry neither
const VALUE_OPS = [...COMPARATOR_OPS, "contains", "includes", "startswith"] as const;
const MEMBER_OPS = ["in", "nin"] as const;
const NULLARY_OPS = ["isnull", "notnull"] as const;

// each branch states its own strictness: without it `{op:"isnull", values:[...]}` parses as a bare
// IS NULL with the array stripped, answering 200 over a set the caller never asked for
export const Filter = z.union([
  z
    .object({
      field: z.string(),
      op: z.enum(VALUE_OPS),
      value: AtlasValue,
    })
    .strict(),
  z
    .object({
      field: z.string(),
      op: z.enum(MEMBER_OPS),
      values: z.array(AtlasValue),
    })
    .strict(),
  z
    .object({
      field: z.string(),
      op: z.enum(NULLARY_OPS),
    })
    .strict(),
]);
export type Filter = z.infer<typeof Filter>;

export const UserSort = z
  .object({
    field: z.string(),
    dir: z.enum(["asc", "desc"]),
  })
  .strict();
export type UserSort = z.infer<typeof UserSort>;

// strictness does not reach nested objects, so a hop states its own: an unknown key here
// is stripped at parse and the query silently runs as something the caller never wrote
export const JoinField = z
  .object({
    field: z.string(),
    as: z.string().optional(),
  })
  .strict();
export type JoinField = z.infer<typeof JoinField>;

// the grain lands inside a dialect's date-trunc string literal, so runtime list and type must be
// the same thing. no week grain: the one bucket where dialects genuinely diverge (ISO vs locale)
export const DATE_GRAINS = ["year", "quarter", "month", "day"] as const;

export const DateGrain = z.enum(DATE_GRAINS);
export type DateGrain = z.infer<typeof DateGrain>;
