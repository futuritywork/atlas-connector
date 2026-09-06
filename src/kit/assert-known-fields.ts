import { unsupported } from "../serve/errors";
import type { SourceQueryWire } from "../wire/schemas";

// Every requested field must be declared, including fields used only for filtering or sorting.
export function assertKnownFields(
  req: Pick<SourceQueryWire, "and" | "or"> & Partial<Pick<SourceQueryWire, "fields" | "sort">>,
  knownFieldNames: Iterable<string>,
): void {
  const known = new Set(knownFieldNames);
  const requested = [
    ...req.and,
    ...(req.or ?? []).flat(),
    ...(req.sort ?? []),
    ...(req.fields ?? []).map((field) => ({ field })),
  ];
  for (const { field } of requested) {
    if (!known.has(field)) {
      throw unsupported(`unknown field '${field}'`);
    }
  }
}
