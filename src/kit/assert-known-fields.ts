import { unsupported } from "../serve/errors";
import type { SourceQueryWire } from "../wire/schemas";

/** the requested, filtered and sorted field names; an unknown one is a 422 rather than unfiltered rows. */
export function assertKnownFields(
  req: Pick<SourceQueryWire, "and" | "or"> & Partial<Pick<SourceQueryWire, "fields" | "sort">>,
  knownFieldNames: Iterable<string>,
): Set<string> {
  const known = new Set(knownFieldNames);
  const filtersAndSorts = [...req.and, ...(req.or ?? []).flat(), ...(req.sort ?? [])];
  const requested = new Set([...(req.fields ?? []), ...filtersAndSorts.map(({ field }) => field)]);
  for (const field of requested) {
    if (!known.has(field)) throw unsupported(`unknown field '${field}'`);
  }
  return requested;
}
