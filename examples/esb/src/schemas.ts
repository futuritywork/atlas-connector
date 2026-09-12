import {
  AtlasBoolean,
  AtlasDate,
  AtlasDatetime,
  AtlasNumeric,
  AtlasValue,
  type AtlasType,
  type SourceRow,
} from "@futurity/atlas-connector";
import { z } from "zod";
import type { EsbCoreObject } from "./types";

export const ESB_APPLICATION_CODE = /^EC\d{8}$/;

const CanonicalDatetime = z.iso
  .datetime({ offset: true })
  .pipe(z.coerce.date())
  .transform((value) => value.toISOString());
const EsbDatetime = z.union([CanonicalDatetime, AtlasDatetime]);
const EsbBoolean = z.union([AtlasBoolean, z.literal(0), z.literal(1)]).transform(Boolean);

export const EsbEnvelope = z.looseObject({});
export type EsbEnvelope = z.infer<typeof EsbEnvelope>;

export const EsbSuccessEnvelope = z.looseObject({
  status: z.literal("ok"),
  code: z.literal("EC03100000"),
  result: z.unknown(),
});

export const EsbFailureEnvelope = z.looseObject({
  status: z.literal("fail"),
  code: z.string().regex(ESB_APPLICATION_CODE),
});

export const EsbMessageEnvelope = z.looseObject({ message: z.string() });

export const EsbPagedCollectionPage = z.looseObject({ page: z.number().int() });

// an empty page and a page past the end both answer data: null
export const EsbPagedCollectionHeader = EsbPagedCollectionPage.extend({
  limit: z.number().int().min(1),
  count: z.number().int().nonnegative().optional(),
  data: z.array(z.unknown()).nullable(),
  next: z.string().optional(),
}).refine((page) => (page.data?.length ?? 0) <= page.limit, { path: ["limit"] });

export const EsbTokenResult = z.looseObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

export const EsbCoreCredentials = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});
export type EsbCoreCredentials = z.infer<typeof EsbCoreCredentials>;

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

  const projection = z.object(shape).pipe(z.record(z.string(), AtlasValue));
  // an all-nullable object would take any JSON as {}
  const requireCatalogField = Object.keys(shape).length > 0;
  let schema: z.ZodType<SourceRow> = projection;
  if (requireCatalogField) {
    schema = projection.refine((row) => Object.keys(row).length > 0, {
      message: `ESB Core ${object.name} row did not contain a catalog field`,
    });
  }

  cacheRow(object, fields, schema);
  return schema;
}

export function EsbCollectionRows(object: EsbCoreObject, fields?: readonly string[]): z.ZodType<SourceRow[]> {
  return z.array(EsbRow(object, fields));
}

const Port = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65_535));

const Config = z.object({
  port: Port,
  bearerToken: z.string().min(32),
});

export function parseEsbConfig(env: Readonly<Record<string, string | undefined>>): z.infer<typeof Config> {
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
