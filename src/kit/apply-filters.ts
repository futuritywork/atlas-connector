// in-memory twin of the sql where-builder: one Filter set, same accept and reject verdicts

import type { AtlasType, Filter, SourceRow } from "../wire/vocabulary";

// plain decimal text only; the wire crosses numbers digit-exact, never in exponent notation
const DECIMAL_TEXT = /^([+-]?)(\d+)(?:\.(\d+))?$/;

const plainDigits = new Intl.NumberFormat("en-US", { useGrouping: false, maximumSignificantDigits: 21 });

type Decimal = { negative: boolean; int: string; frac: string };

/** compares by utf-8 byte order; plain `<` compares utf-16 units and misorders astral chars. */
export function byteOrderCompare(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length) {
    // i < length, so a code point exists at i
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function parseDecimal(text: string): Decimal | null {
  const match = DECIMAL_TEXT.exec(text);
  if (!match) return null;
  // group 2 always captures on a match
  const int = (match[2] as string).replace(/^0+(?=\d)/, "");
  const frac = (match[3] ?? "").replace(/0+$/, "");
  // "-0" and "-0.00" are zero, and zero has no sign
  const negative = match[1] === "-" && !(int === "0" && frac === "");
  return { negative, int, frac };
}

/** digit-exact ordering, so >2^53 twins stay distinct where a double would fold them. */
export function decimalCompare(a: string, b: string): number | null {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  if (!left || !right) return null;
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const flip = left.negative ? -1 : 1;
  if (left.int.length !== right.int.length) {
    return (left.int.length < right.int.length ? -1 : 1) * flip;
  }
  if (left.int !== right.int) return (left.int < right.int ? -1 : 1) * flip;
  if (left.frac === right.frac) return 0;
  // trailing zeros are stripped, so prefix-is-smaller is exact
  return (left.frac < right.frac ? -1 : 1) * flip;
}

// null on either side is sql UNKNOWN: nothing matches, like `col = NULL`
function compareValues(value: unknown, bound: unknown, type: AtlasType | undefined): number | null {
  if (value == null || bound == null) return null;
  const left = String(value);
  const right = String(bound);
  // String() gives exponent notation past 1e21, which DECIMAL_TEXT rejects
  if (type === "number" || type === "decimal") {
    return decimalCompare(
      typeof value === "number" ? plainDigits.format(value) : left,
      typeof bound === "number" ? plainDigits.format(bound) : right,
    );
  }
  // an undeclared column is digit-exact only when both sides spell a plain decimal
  if (type === undefined) return decimalCompare(left, right) ?? byteOrderCompare(left, right);
  return byteOrderCompare(left, right);
}

function equalsValue(value: unknown, bound: unknown, type: AtlasType | undefined): boolean {
  return compareValues(value, bound, type) === 0;
}

// arrays reach a wire row as JSON text; an author's pre-wire rows may still hold real arrays
function arrayElements(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function matchesFilter(row: SourceRow, filter: Filter, fieldTypes: Record<string, AtlasType> | undefined): boolean {
  const value = row[filter.field] ?? null;
  const type = fieldTypes?.[filter.field];
  switch (filter.op) {
    case "eq":
      return equalsValue(value, filter.value, type);
    case "neq": {
      const order = compareValues(value, filter.value, type);
      return order !== null && order !== 0;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const order = compareValues(value, filter.value, type);
      if (order === null) return false;
      if (filter.op === "gt") return order > 0;
      if (filter.op === "gte") return order >= 0;
      if (filter.op === "lt") return order < 0;
      return order <= 0;
    }
    // a null member never matches, and an empty `in` matches nothing
    case "in":
      return value !== null && filter.values.some((member) => member !== null && equalsValue(value, member, type));
    // nin keeps null rows, and an empty set excludes nothing
    case "nin":
      return value === null || !filter.values.some((member) => member !== null && equalsValue(value, member, type));
    // the sql side LIKEs col::text, so both ops stringify the cell first
    case "includes":
      return value !== null && filter.value !== null && String(value).includes(String(filter.value));
    case "startswith":
      return value !== null && filter.value !== null && String(value).startsWith(String(filter.value));
    case "contains": {
      if (filter.value === null) return false;
      const elements = arrayElements(value);
      if (!elements) return false;
      return elements.some((element) => element != null && equalsValue(element, filter.value, undefined));
    }
    case "isnull":
      return value === null;
    case "notnull":
      return value !== null;
  }
}

/** and[] conjoined, or[][] as DNF, the whole or-block one further conjunct. */
export function applyFilters(
  rows: SourceRow[],
  filters: { and: Filter[]; or?: Filter[][] },
  fieldTypes?: Record<string, AtlasType>,
): SourceRow[] {
  const { and, or } = filters;
  return rows.filter((row) => {
    if (!and.every((filter) => matchesFilter(row, filter, fieldTypes))) return false;
    if (!or || or.length === 0) return true;
    return or.some((group) => group.every((filter) => matchesFilter(row, filter, fieldTypes)));
  });
}
