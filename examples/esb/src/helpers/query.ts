import {
  byteOrderCompare,
  decimalCompare,
  type AtlasType,
  type AtlasValue,
  type NativeQueryRequest,
  type SourceRow,
} from "@futurity/atlas-connector";

function compareCells(a: Exclude<AtlasValue, null>, b: Exclude<AtlasValue, null>, type: AtlasType): number {
  if (type === "number" || type === "decimal") {
    return decimalCompare(String(a), String(b)) ?? byteOrderCompare(String(a), String(b));
  }
  return byteOrderCompare(String(a), String(b));
}

export function sortRows(
  rows: SourceRow[],
  sort: NativeQueryRequest["sort"],
  fieldTypes: Readonly<Record<string, AtlasType>>,
): void {
  rows.sort((a, b) => {
    for (const key of sort) {
      const left = a[key.field] ?? null;
      const right = b[key.field] ?? null;
      if (left === null || right === null) {
        if (left === null && right === null) continue;
        return left === null ? 1 : -1;
      }
      const type = fieldTypes[key.field];
      if (type === undefined) throw new Error(`esb-core: no catalog type for sort field '${key.field}'`);
      const order = compareCells(left, right, type);
      if (order !== 0) return key.dir === "desc" ? -order : order;
    }
    return 0;
  });
}

export function projectRows(rows: SourceRow[], fields: string[]): SourceRow[] {
  return rows.map((row) => {
    const selected: SourceRow = {};
    for (const field of fields) selected[field] = row[field] ?? null;
    return selected;
  });
}
