import type { AtlasValue, Filter, NativeQueryRequest, Op, Pushdown, Served } from "@futurity/atlas-connector";
import { ESB_CORE_CATALOG } from "../catalog";
import type { EsbCoreObject, EsbFilterParam } from "../types";

const DATE_FLOOR = "1900-01-01";
const DATE_CEILING = "2100-12-31";

// undefined until discovery measures this tenant
export type HonoredParams = ReadonlySet<string> | undefined;

export type QueryPlan = {
  params: Record<string, string>;
  served: Served; // anything false leaves a residual for the host
};

type PlanDraft = { params: Record<string, string>; filters: boolean; sort: boolean };

export function paramLabel(entry: EsbFilterParam): string {
  return "param" in entry ? entry.param : `${entry.from}/${entry.to}`;
}

export function paramKey(object: EsbCoreObject, entry: EsbFilterParam): string {
  return `${object.name}:${paramLabel(entry)}`;
}

function filtersOf(object: EsbCoreObject, honored: HonoredParams): EsbFilterParam[] {
  const declared = object.filters ?? [];
  return honored === undefined ? declared : declared.filter((entry) => honored.has(paramKey(object, entry)));
}

function pushdownOf(object: EsbCoreObject): Map<string, Set<Op>> {
  const byField = new Map<string, Set<Op>>();
  for (const entry of filtersOf(object, undefined)) {
    const ops = byField.get(entry.field) ?? new Set<Op>();
    for (const op of entry.ops) ops.add(op);
    byField.set(entry.field, ops);
  }
  return byField;
}

// date params compare as YYYY-MM-DD
function asDay(value: AtlasValue): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function asText(value: AtlasValue): string | null {
  return value === null || typeof value === "boolean" ? null : String(value);
}

// one filter per param; a second would over-narrow
function writeParam(draft: PlanDraft, param: string, value: string | null): boolean {
  if (value === null || draft.params[param] !== undefined) return false;
  draft.params[param] = value;
  return true;
}

function pushFilter(draft: PlanDraft, entry: EsbFilterParam, filter: Filter): boolean {
  if ("param" in entry) {
    if (filter.op === "in") {
      const values = filter.values.map(asText);
      // comma-joined set: a null or an embedded comma has no spelling
      if (values.length === 0 || values.some((value) => value === null || value.includes(","))) return false;
      return writeParam(draft, entry.param, values.join(","));
    }
    return filter.op === "eq" && writeParam(draft, entry.param, asText(filter.value));
  }
  if (filter.op === "eq") {
    const day = asDay(filter.value);
    return writeParam(draft, entry.from, day) && writeParam(draft, entry.to, day);
  }
  if (filter.op === "gte") return writeParam(draft, entry.from, asDay(filter.value));
  if (filter.op === "lte") return writeParam(draft, entry.to, asDay(filter.value));
  return false;
}

function entryFor(entries: readonly EsbFilterParam[], filter: Filter): EsbFilterParam | undefined {
  return entries.find((entry) => entry.field === filter.field && entry.ops.includes(filter.op));
}

// an open end matches nothing upstream
function widenOpenRanges(draft: PlanDraft, entries: readonly EsbFilterParam[]): void {
  for (const entry of entries) {
    if (!("from" in entry)) continue;
    const from = draft.params[entry.from];
    const to = draft.params[entry.to];
    if (from === undefined && to !== undefined) draft.params[entry.from] = DATE_FLOOR;
    if (to === undefined && from !== undefined) draft.params[entry.to] = DATE_CEILING;
  }
}

function pushSort(draft: PlanDraft, object: EsbCoreObject, sort: NativeQueryRequest["sort"]): void {
  const [key, ...rest] = sort;
  if (key === undefined) return;
  const column = object.columns.find((entry) => entry.name === key.field);
  // ESB puts nulls first ascending; Atlas wants them last
  const nullsAgree = key.dir === "desc" || column?.nullable === false;
  const sortable = object.sortFields?.includes(key.field) ?? false;
  if (rest.length > 0 || !sortable || !nullsAgree) {
    draft.sort = false;
    return;
  }
  const prefix = key.dir === "desc" ? "-" : "";
  draft.params.sort = `${prefix}${key.field}`;
}

export function esbPushdown(): Pushdown {
  const entities: NonNullable<Pushdown["entities"]> = {};
  for (const object of ESB_CORE_CATALOG) {
    const fields: Record<string, Op[]> = {};
    for (const [field, ops] of pushdownOf(object)) fields[field] = [...ops];
    entities[object.name] = { ops: [], fields };
  }
  // one sort key, and an offset is a page jump
  return { entities, sort: "single", offset: true, join: false };
}

export function planQuery(
  object: EsbCoreObject,
  req: Pick<NativeQueryRequest, "and" | "or" | "sort">,
  honored: HonoredParams,
): QueryPlan {
  const draft: PlanDraft = { params: {}, filters: true, sort: true };
  const entries = filtersOf(object, honored);
  for (const filter of req.and) {
    const entry = entryFor(entries, filter);
    if (entry === undefined || !pushFilter(draft, entry, filter) || entry.superset) draft.filters = false;
  }
  // params are anded, so an or-group has no spelling
  if ((req.or?.length ?? 0) > 0) draft.filters = false;

  widenOpenRanges(draft, entries);
  pushSort(draft, object, req.sort);

  const served = { filters: draft.filters, sort: draft.sort, window: draft.filters && draft.sort };
  return { params: draft.params, served };
}
