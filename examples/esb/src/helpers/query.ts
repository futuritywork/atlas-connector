import type {
  AtlasType,
  AtlasValue,
  Filter,
  SourceRow,
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

type Decimal = { negative: boolean; int: string; frac: string };

const DECIMAL_TEXT = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function compareByteOrder(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length) {
    const left = a.codePointAt(index) as number;
    const right = b.codePointAt(index) as number;
    if (left !== right) return left < right ? -1 : 1;
    index += left > 0xffff ? 2 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function parseDecimal(text: string): Decimal | null {
  const match = DECIMAL_TEXT.exec(text);
  if (!match) return null;
  const int = (match[2] as string).replace(/^0+(?=\d)/, "");
  const frac = (match[3] ?? "").replace(/0+$/, "");
  const negative = match[1] === "-" && !(int === "0" && frac === "");
  return { negative, int, frac };
}

function compareDecimals(a: string, b: string): number | null {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  if (!left || !right) return null;
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const flip = left.negative ? -1 : 1;
  if (left.int.length !== right.int.length) return (left.int.length < right.int.length ? -1 : 1) * flip;
  if (left.int !== right.int) return (left.int < right.int ? -1 : 1) * flip;
  if (left.frac === right.frac) return 0;
  return (left.frac < right.frac ? -1 : 1) * flip;
}

function compareCells(a: Exclude<AtlasValue, null>, b: Exclude<AtlasValue, null>, type: AtlasType): number {
  if (type === "number" || type === "decimal") {
    return compareDecimals(String(a), String(b)) ?? compareByteOrder(String(a), String(b));
  }
  return compareByteOrder(String(a), String(b));
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
      const order = compareCells(left, right, fieldTypes.get(key.field) ?? "string");
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
