import {
  AtlasBoolean,
  AtlasDate,
  AtlasDatetime,
  AtlasNumeric,
  AtlasValue,
  Filter,
  type AtlasType,
  type SourceRow,
} from "@futurity/atlas-connector";
import { z } from "zod";
import type { EsbCoreObject } from "./types";

const COMPARATOR_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
const COMPARATOR_OP_SET: ReadonlySet<string> = new Set(COMPARATOR_OPS);
const ComparatorOp = z.enum(COMPARATOR_OPS);

const CanonicalDatetime = z
  .iso.datetime({ offset: true })
  .pipe(z.coerce.date())
  .transform((value) => value.toISOString());
const EsbDatetime = z.union([CanonicalDatetime, AtlasDatetime]);
const EsbBoolean = z.union([AtlasBoolean, z.literal(0), z.literal(1)]).transform(Boolean);

export const EsbDatetimeValue = EsbDatetime.nullable();
export const EsbDateValue = AtlasDate.nullable();

export const EsbEnvelope = z.looseObject({});
export type EsbEnvelope = z.infer<typeof EsbEnvelope>;

export const EsbSuccessEnvelope = z.looseObject({
  status: z.literal("ok"),
  code: z.literal("EC03100000"),
  result: z.unknown(),
});

export const EsbFailureEnvelope = z.looseObject({
  status: z.literal("fail"),
  code: z.string().regex(/^EC\d{8}$/),
});

export const EsbMessageEnvelope = z.looseObject({ message: z.string() });
export const EsbPagedCollectionPage = z.looseObject({ page: z.number().int() });
export const EsbPagedCollectionHeader = EsbPagedCollectionPage.extend({
  limit: z.number().int().min(1),
  data: z.array(z.unknown()),
  next: z.string().optional(),
}).refine((page) => page.data.length <= page.limit, { path: ["limit"] });

export const EsbTokenResult = z.looseObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

export const EsbCoreCredentials = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});
export type EsbCoreCredentials = z.infer<typeof EsbCoreCredentials>;

const Port = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(65_535));
const Config = z.object({
  port: Port,
  bearerToken: z.string().min(32),
});

export function parseEsbConfig(
  env: Readonly<Record<string, string | undefined>>,
): { port: number; bearerToken: string } {
  const result = Config.safeParse({
    port: env.PORT ?? env.CONNECTOR_PORT ?? "4100",
    bearerToken: env.ATLAS_CONNECTOR_TOKEN,
  });
  if (result.success) return result.data;
  if (result.error.issues.some((issue) => issue.path[0] === "port")) {
    throw new Error("PORT or CONNECTOR_PORT must be an integer between 1 and 65535");
  }
  throw new Error("ATLAS_CONNECTOR_TOKEN must be set to at least 32 characters");
}

function rowValue(type: AtlasType): z.ZodType<AtlasValue> {
  switch (type) {
    case "string":
    case "reference":
    case "json":
    case "array":
      return z.string();
    case "number":
    case "decimal":
      return AtlasNumeric;
    case "boolean":
      return EsbBoolean;
    case "date":
      return AtlasDate;
    case "datetime":
      return EsbDatetime;
  }
}

const fullRows = new WeakMap<EsbCoreObject, z.ZodType<SourceRow>>();
const projectedRows = new WeakMap<readonly string[], WeakMap<EsbCoreObject, z.ZodType<SourceRow>>>();

function cachedRow(object: EsbCoreObject, fields?: readonly string[]): z.ZodType<SourceRow> | undefined {
  return fields === undefined ? fullRows.get(object) : projectedRows.get(fields)?.get(object);
}

function cacheRow(
  object: EsbCoreObject,
  fields: readonly string[] | undefined,
  schema: z.ZodType<SourceRow>,
): void {
  if (fields === undefined) {
    fullRows.set(object, schema);
    return;
  }
  const byObject = projectedRows.get(fields) ?? new WeakMap<EsbCoreObject, z.ZodType<SourceRow>>();
  byObject.set(object, schema);
  projectedRows.set(fields, byObject);
}

export function EsbRow(object: EsbCoreObject, fields?: readonly string[]): z.ZodType<SourceRow> {
  const cached = cachedRow(object, fields);
  if (cached) return cached;

  const selected = fields === undefined ? undefined : new Set(fields);
  const shape: Record<string, z.ZodType<AtlasValue | undefined>> = {};
  for (const column of object.columns) {
    if (selected && !selected.has(column.name)) continue;
    const value = rowValue(column.type);
    shape[column.name] = column.nullable ? value.nullable().optional() : value;
  }
  const projection = z.object(shape).strip().pipe(z.record(z.string(), AtlasValue));
  // A row contributing no catalog field is not a row of this entity: without this, an all-nullable
  // object like goods_deliveries accepts arbitrary JSON as {}. count() projects to nothing on
  // purpose, though, so an empty selection has no field to require.
  const schema =
    Object.keys(shape).length === 0
      ? projection
      : projection.refine((row) => Object.keys(row).length > 0, {
          message: `ESB Core ${object.name} row did not contain a catalog field`,
        });
  cacheRow(object, fields, schema);
  return schema;
}

export function EsbCollectionRows(
  object: EsbCoreObject,
  fields?: readonly string[],
): z.ZodType<SourceRow[]> {
  return z.array(EsbRow(object, fields));
}

const [ValueFilter, MemberFilter] = Filter.options;
if (!("value" in ValueFilter.shape) || !("values" in MemberFilter.shape)) {
  throw new Error("Atlas Filter schema branches changed: expected value and member filters first");
}

const StringFilterValue = z.string().nullable();
const NumericFilterValue = AtlasNumeric.nullable();
const BooleanFilterValue = z.boolean().nullable();

type FilterSet = {
  and: Filter[];
  or?: Filter[][];
};

export function EsbFilterSet(
  fieldTypes: Readonly<Record<string, AtlasType>>,
): z.ZodType<FilterSet> {
  const fieldOfType = (...types: AtlasType[]) =>
    z.string().refine((field) => {
      const type = fieldTypes[field];
      return type !== undefined && types.includes(type);
    });
  const datetimeField = fieldOfType("datetime");
  const dateField = fieldOfType("date");
  const numericField = fieldOfType("number", "decimal");
  const booleanField = fieldOfType("boolean");
  const stringField = fieldOfType("string");
  const typedTypes = new Set<AtlasType>(["datetime", "date", "number", "decimal", "boolean", "string"]);
  const residualFilter = Filter.refine((filter) => {
    const type = fieldTypes[filter.field];
    if (type === undefined || !typedTypes.has(type)) return true;
    if ("values" in filter) return false;
    return !("value" in filter) || !COMPARATOR_OP_SET.has(filter.op);
  });

  const normalizedFilter = z.union([
    ValueFilter.extend({ field: datetimeField, op: ComparatorOp, value: EsbDatetimeValue }),
    MemberFilter.extend({ field: datetimeField, values: z.array(EsbDatetimeValue) }),
    ValueFilter.extend({ field: dateField, op: ComparatorOp, value: EsbDateValue }),
    MemberFilter.extend({ field: dateField, values: z.array(EsbDateValue) }),
    ValueFilter.extend({ field: numericField, op: ComparatorOp, value: NumericFilterValue }),
    MemberFilter.extend({ field: numericField, values: z.array(NumericFilterValue) }),
    ValueFilter.extend({ field: booleanField, op: ComparatorOp, value: BooleanFilterValue }),
    MemberFilter.extend({ field: booleanField, values: z.array(BooleanFilterValue) }),
    ValueFilter.extend({ field: stringField, op: ComparatorOp, value: StringFilterValue }),
    MemberFilter.extend({ field: stringField, values: z.array(StringFilterValue) }),
    residualFilter,
  ]);

  return z
    .object({
      and: z.array(normalizedFilter),
      or: z.array(z.array(normalizedFilter)).optional(),
    })
    .strict();
}
