import { unsupported } from "../serve/errors";
import type { SourceQueryWire } from "../wire/schemas";

// Return every requested field after checking it against the catalog, including filter/sort-only fields.
export function assertKnownFields(
  req: Pick<SourceQueryWire, "and" | "or"> & Partial<Pick<SourceQueryWire, "fields" | "sort">>,
  knownFieldNames: Iterable<string>,
): Set<string> {
  const known = new Set(knownFieldNames);
  const requested = new Set([
    ...(req.fields ?? []),
    ...[...req.and, ...(req.or ?? []).flat(), ...(req.sort ?? [])].map(({ field }) => field),
  ]);
  for (const field of requested) {
    if (!known.has(field)) {
      throw unsupported(`unknown field '${field}'`);
    }
  }
  return requested;
}
