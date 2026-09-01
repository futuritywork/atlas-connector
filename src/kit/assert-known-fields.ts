import { unsupported } from "../serve/errors";
import type { Filter } from "../wire/vocabulary";

// a filter on a field the connector cannot push down must 422, never come back as unfiltered
// rows: Atlas trusts every answered row to satisfy every filter it sent
export function assertKnownFields(
  req: { and: Filter[]; or?: Filter[][] },
  knownFieldNames: Iterable<string>,
): void {
  const known = new Set(knownFieldNames);
  for (const filter of [...req.and, ...(req.or ?? []).flat()]) {
    if (!known.has(filter.field)) {
      throw unsupported(`unknown filter field '${filter.field}'`);
    }
  }
}
