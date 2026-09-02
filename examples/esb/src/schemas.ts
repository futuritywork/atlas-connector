import {
  AtlasValue,
  Filter,
  type AtlasType,
} from "@futurity/atlas-connector";
import { z } from "zod";

const CanonicalDatetime = z
  .iso.datetime({ offset: true })
  .pipe(z.coerce.date())
  .transform((value) => value.toISOString());

export const EsbDatetimeValue = z.union([CanonicalDatetime, AtlasValue]);

const [ValueFilter, MemberFilter] = Filter.options;
if (!("value" in ValueFilter.shape) || !("values" in MemberFilter.shape)) {
  throw new Error("Atlas Filter schema branches changed: expected value and member filters first");
}

type FilterSet = {
  and: Filter[];
  or?: Filter[][];
};

export function createFilterSetSchema(
  fieldTypes: Readonly<Record<string, AtlasType>>,
): z.ZodType<FilterSet> {
  // Atlas dates are already canonical YYYY-MM-DD values, only datetime need timezone normalization.
  const datetimeField = z.string().refine((field) => fieldTypes[field] === "datetime");
  const normalizedFilter = z.union([
    ValueFilter.extend({ field: datetimeField, value: EsbDatetimeValue }),
    MemberFilter.extend({ field: datetimeField, values: z.array(EsbDatetimeValue) }),
    Filter,
  ]);

  return z
    .object({
      and: z.array(normalizedFilter),
      or: z.array(z.array(normalizedFilter)).optional(),
    })
    .strict();
}
