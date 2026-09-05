import {
  byteOrderCompare,
  decimalCompare,
  type AtlasType,
  type AtlasValue,
  type Filter,
  type SourceRow,
} from "@futurity/atlas-connector";
import type { EsbCoreObject } from "../types";

export type QueryShape = {
  table: string;
  and: Filter[];
  or?: Filter[][];
  fields: string[];
  sort?: Array<{ field: string; dir: "asc" | "desc" }>;
  joins?: unknown[];
};

function compareCells(a: Exclude<AtlasValue, null>, b: Exclude<AtlasValue, null>, type: AtlasType): number {
  if (type === "number" || type === "decimal") {
    return decimalCompare(String(a), String(b)) ?? byteOrderCompare(String(a), String(b));
  }
  return byteOrderCompare(String(a), String(b));
}

export function sortRows(
  rows: SourceRow[],
  sort: Array<{ field: string; dir: "asc" | "desc" }>,
  fieldTypes: ReadonlyMap<string, AtlasType>,
): void {
  rows.sort((a, b) => {
    for (const key of sort) {
      const left = a[key.field] ?? null;
      const right = b[key.field] ?? null;
      if (left === null || right === null) {
        if (left === null && right === null) continue;
        return left === null ? 1 : -1;
      }
      const type = fieldTypes.get(key.field);
      if (type === undefined) throw new Error(`esb-core: no catalog type for sort field '${key.field}'`);
      const order = compareCells(left, right, type);
      if (order !== 0) return key.dir === "desc" ? -order : order;
    }
    return 0;
  });
}

export function collectNeededColumns(req: QueryShape, object: EsbCoreObject): Set<string> {
  const fields = new Set(req.fields);
  for (const filter of req.and) fields.add(filter.field);
  for (const group of req.or ?? []) for (const filter of group) fields.add(filter.field);
  for (const sort of req.sort ?? []) fields.add(sort.field);
  if (object.primaryKey) fields.add(object.primaryKey);
  return fields;
}

export function projectRows(rows: SourceRow[], fields: string[]): SourceRow[] {
  return rows.map((row) => {
    const selected: SourceRow = {};
    for (const field of fields) selected[field] = row[field] ?? null;
    return selected;
  });
}
