// atlas filters → bitable search conditions, for the subset lark evaluates with the same
// semantics as applyFilters. query() always re-applies the FULL filter set locally, so a
// pushed condition may only narrow the fetch — never widen it, never replace the local check.

import type { Filter } from "@futurity/atlas-connector";
import type { LarkCondition, LarkField } from "./lark-api";
import { LARK_TYPE } from "./field-map";

const TEXT_LIKE = new Set<number>([LARK_TYPE.text, LARK_TYPE.phone, LARK_TYPE.url, LARK_TYPE.autoNumber]);

// atlas op → lark operator where both sides agree; anything absent stays local-only
const NUMBER_OPS: Record<string, string> = {
  eq: "is",
  neq: "isNot",
  gt: "isGreater",
  gte: "isGreaterEqual",
  lt: "isLess",
  lte: "isLessEqual",
};
const TEXT_OPS: Record<string, string> = { eq: "is", neq: "isNot", includes: "contains" };
const SELECT_OPS: Record<string, string> = { eq: "is", neq: "isNot" };

// operator table for a field's type; null = the type never pushes value comparisons.
// dates stay here on purpose: day-granular (ExactDate) upstream vs millisecond iso in atlas
function opsForType(type: number): Record<string, string> | null {
  if (type === LARK_TYPE.number) return NUMBER_OPS;
  if (TEXT_LIKE.has(type)) return TEXT_OPS;
  if (type === LARK_TYPE.singleSelect) return SELECT_OPS;
  return null;
}

// formula and lookup fields cannot be filter conditions at all
function pushOne(filter: Filter, field: LarkField): LarkCondition | null {
  const name = field.field_name;
  if (field.type === LARK_TYPE.formula || field.type === LARK_TYPE.lookup) return null;
  if (filter.op === "isnull" || filter.op === "notnull") {
    return { field_name: name, operator: filter.op === "isnull" ? "isEmpty" : "isNotEmpty", value: [] };
  }
  // in/nin are the only valueless ops left — they never push, atlas set-matches locally
  if (!("value" in filter)) return null;

  if (filter.value === null) return null;
  if (typeof filter.value === "boolean") {
    const pushable = field.type === LARK_TYPE.checkbox && filter.op === "eq";
    return pushable ? { field_name: name, operator: "is", value: [String(filter.value)] } : null;
  }

  const operator = opsForType(field.type)?.[filter.op];
  return operator ? { field_name: name, operator, value: [String(filter.value)] } : null;
}

// only and[] conjuncts push: they constrain every result row even when an or-block exists.
// bitable caps a filter at 50 conditions; overflow simply stays local.
export function pushdownConditions(and: Filter[], fieldsByName: Map<string, LarkField>): LarkCondition[] {
  const conditions: LarkCondition[] = [];
  for (const filter of and) {
    const field = fieldsByName.get(filter.field);
    if (!field) continue;
    const condition = pushOne(filter, field);
    if (condition) conditions.push(condition);
    if (conditions.length === 50) break;
  }
  return conditions;
}
