// capability.ts emits its advertised operators from these tables

import { OPS, type Filter, type Op, type Pushdown, type Served, type UserSort } from "@futurity/atlas-connector";
import { LARK_TYPE, RECORD_ID } from "./field-map";
import type { LarkCondition, LarkField, LarkFilter, LarkSortKey } from "./lark-api";

type Push = { operator: string; exact: boolean }; // exact: lark's match is atlas's, not a superset

type OpTable = Record<string, Push>;

const NUMBER_OPS: OpTable = {
  eq: { operator: "is", exact: true },
  neq: { operator: "isNot", exact: true },
  gt: { operator: "isGreater", exact: true },
  gte: { operator: "isGreaterEqual", exact: true },
  lt: { operator: "isLess", exact: true },
  lte: { operator: "isLessEqual", exact: true },
};

// case-insensitive and trims, so no neq: inverting a loose match drops real rows
const TEXT_OPS: OpTable = {
  eq: { operator: "is", exact: false },
  includes: { operator: "contains", exact: false },
  startswith: { operator: "contains", exact: false },
};

// option names compare case-sensitively, as atlas does
const SELECT_OPS: OpTable = { eq: { operator: "is", exact: true }, neq: { operator: "isNot", exact: true } };

const CHECKBOX_OPS: OpTable = { eq: { operator: "is", exact: true } };

const EMPTINESS_OPS: OpTable = {
  isnull: { operator: "isEmpty", exact: true },
  notnull: { operator: "isNotEmpty", exact: true },
};

const TEXT_LIKE = new Set<number>([LARK_TYPE.text, LARK_TYPE.phone, LARK_TYPE.url, LARK_TYPE.autoNumber]);

// ordered as atlas compares; select sorts by option position, so it is absent
const SORTABLE_TYPES = new Set<number>([
  LARK_TYPE.number,
  LARK_TYPE.text,
  LARK_TYPE.date,
  LARK_TYPE.createdTime,
  LARK_TYPE.modifiedTime,
]);

const MAX_CONDITIONS = 50; // bitable's ceiling, children included

// lark parses the text itself: 1e6 is a million, "3abc" is 1254018
const PLAIN_DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;
const decimalFormat = new Intl.NumberFormat("en-US", { useGrouping: false, maximumSignificantDigits: 21 });

function decimalText(value: string | number | boolean): string | null {
  const text = typeof value === "number" ? decimalFormat.format(value) : String(value);
  return PLAIN_DECIMAL.test(text) ? text : null;
}

function opsForField(field: LarkField): { value: OpTable; nullary: OpTable } | null {
  const { type } = field;
  if (type === LARK_TYPE.formula || type === LARK_TYPE.lookup) return null;
  // a checkbox is never empty; isEmpty on one is 1254018
  if (type === LARK_TYPE.checkbox) return { value: CHECKBOX_OPS, nullary: {} };
  if (type === LARK_TYPE.number) return { value: NUMBER_OPS, nullary: EMPTINESS_OPS };
  if (type === LARK_TYPE.singleSelect) return { value: SELECT_OPS, nullary: EMPTINESS_OPS };
  if (TEXT_LIKE.has(type)) return { value: TEXT_OPS, nullary: EMPTINESS_OPS };
  return { value: {}, nullary: EMPTINESS_OPS };
}

function isOptionName(field: LarkField, value: string): boolean {
  return (field.property?.options ?? []).some((option) => option.name === value);
}

type PushedCondition = { condition: LarkCondition; exact: boolean };

function pushCondition(filter: Filter, field: LarkField): PushedCondition | null {
  const tables = opsForField(field);
  if (!tables) return null;
  const name = field.field_name;

  if (filter.op === "isnull" || filter.op === "notnull") {
    const push = tables.nullary[filter.op];
    return push ? { condition: { field_name: name, operator: push.operator, value: [] }, exact: push.exact } : null;
  }
  // in/nin carry no scalar; atlas set-matches them
  if (!("value" in filter)) return null;
  // null matches nothing in atlas, everything-or-error upstream
  if (filter.value === null) return null;

  const push = tables.value[filter.op];
  if (!push) return null;
  if (field.type === LARK_TYPE.checkbox && typeof filter.value !== "boolean") return null;
  // an unknown option name fails the whole search (1254018)
  if (field.type === LARK_TYPE.singleSelect && !isOptionName(field, String(filter.value))) return null;
  const text = field.type === LARK_TYPE.number ? decimalText(filter.value) : String(filter.value);
  if (text === null) return null;
  return { condition: { field_name: name, operator: push.operator, value: [text] }, exact: push.exact };
}

type CompiledGroup = { conditions: LarkCondition[]; exact: boolean };

function compileGroup(and: readonly Filter[], fieldsByName: Map<string, LarkField>): CompiledGroup {
  const conditions: LarkCondition[] = [];
  let exact = true;
  for (const filter of and) {
    const field = fieldsByName.get(filter.field);
    const pushed = field ? pushCondition(filter, field) : null;
    if (!pushed) {
      exact = false;
      continue;
    }
    conditions.push(pushed.condition);
    exact &&= pushed.exact;
  }
  return { conditions, exact };
}

type FilterPlan = { filter?: LarkFilter; exact: boolean };

function andPlan(group: CompiledGroup, exact: boolean): FilterPlan {
  const conditions = group.conditions.slice(0, MAX_CONDITIONS);
  return {
    ...(conditions.length > 0 ? { filter: { conjunction: "and" as const, conditions } } : {}),
    exact,
  };
}

// one level of nesting, so the and[] distributes into every or-group as a DNF
export function planFilter(
  and: readonly Filter[],
  or: readonly Filter[][] | undefined,
  fieldsByName: Map<string, LarkField>,
): FilterPlan {
  const conjunction = compileGroup(and, fieldsByName);
  const truncated = conjunction.conditions.length > MAX_CONDITIONS;
  if (!or || or.length === 0) return andPlan(conjunction, conjunction.exact && !truncated);

  const branches = or.map((group) => compileGroup(group, fieldsByName));
  const total = branches.reduce((sum, branch) => sum + conjunction.conditions.length + branch.conditions.length, 0);
  // a branch pushing nothing matches every row the and[] does, so the disjunction collapses to it
  if (branches.some((branch) => branch.conditions.length === 0) || total > MAX_CONDITIONS) {
    return andPlan(conjunction, false);
  }

  const children = branches.map((branch) => ({
    conjunction: "and" as const,
    conditions: [...conjunction.conditions, ...branch.conditions],
  }));
  const exact = conjunction.exact && branches.every((branch) => branch.exact);
  return { filter: { conjunction: "or", children }, exact };
}

// null when lark would order a key differently than atlas
export function planSort(sort: readonly UserSort[], fieldsByName: Map<string, LarkField>): LarkSortKey[] | null {
  const keys: LarkSortKey[] = [];
  for (const key of sort) {
    const field = fieldsByName.get(key.field);
    if (!field || !SORTABLE_TYPES.has(field.type)) return null;
    // bitable puts empty cells last both ways, which is atlas's rule
    keys.push({ field_name: key.field, desc: key.dir === "desc" });
  }
  return keys;
}

export function servedBy(filter: FilterPlan, sort: LarkSortKey[] | null): Served {
  const filters = filter.exact;
  const sorted = sort !== null;
  return { filters, sort: sorted, window: filters && sorted };
}

// record_id carries no upstream filter, so an eq on it reads by GET
export function recordIdLookup(and: readonly Filter[]): string | null {
  for (const filter of and) {
    if (filter.field !== RECORD_ID || filter.op !== "eq") continue;
    if (typeof filter.value === "string" && filter.value.length > 0) return filter.value;
  }
  return null;
}

function everyPushedOp(): Op[] {
  const tables = [NUMBER_OPS, TEXT_OPS, SELECT_OPS, CHECKBOX_OPS, EMPTINESS_OPS];
  const pushed = new Set(tables.flatMap((table) => Object.keys(table)));
  // OPS order, so every connector advertises the same sequence
  return OPS.filter((op) => pushed.has(op));
}

// source-wide: a field's lark type alone decides the push
export const LARK_PUSHDOWN: Pushdown = {
  ops: everyPushedOp(),
  sort: "multi",
  offset: true, // bitable pages by cursor, so the connector walks to the offset
  join: false,
};
