import type { DateGrain, Op } from "../wire/vocabulary";
import type { Catalog } from "./catalog";

// the dialect seam: only spellings live here. protocol law (nin keeps nulls, empty-in = 1=0,
// NULLS LAST, DNF or-groups, LIKE escaping, t0..tN join chains, 2^53 fencing) stays in the builders.
export type SqlFlavor = {
  placeholder(index: number): string; // 1-based: placeholder(3) → "$3"
  quoteIdent(name: string): string;
  bytePin(expr: string): string; // byte identity for pinned text; a locale collation folds case
  castText(expr: string): string; // exact server-side decimal text, never a JS float
  numericParam(placeholder: string): string; // exact numeric compare past 2^53
  renderDate(expr: string): string; // YYYY-MM-DD
  renderDatetime(expr: string): string; // YYYY-MM-DDTHH:MM:SS — UTC session assumed
  dateTrunc(grain: DateGrain, expr: string): string; // ISO period-start text
  arrayContains?(bound: string, col: string): string; // absent → `contains` is never advertised
  likeEscape: string;
  countCast(expr: string): string;
};

// every builder input in one bag; operators is the advertised set, so an op the capability
// document never promised is refused before it can render
export type SqlContext = {
  catalog: Catalog;
  schema: string;
  flavor: SqlFlavor;
  operators: ReadonlySet<Op>;
};

export function postgres(): SqlFlavor {
  return {
    placeholder: (index) => `$${index}`,
    quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
    bytePin: (expr) => `${expr} COLLATE "C"`,
    castText: (expr) => `${expr}::text`,
    numericParam: (placeholder) => `${placeholder}::numeric`,
    renderDate: (expr) => `to_char(${expr}, 'YYYY-MM-DD')`,
    renderDatetime: (expr) => `to_char(${expr}, 'YYYY-MM-DD"T"HH24:MI:SS')`,
    dateTrunc: (grain, expr) => `to_char(date_trunc('${grain}', ${expr}), 'YYYY-MM-DD')`,
    arrayContains: (bound, col) => `${bound} = ANY(${col})`,
    likeEscape: "ESCAPE '\\'",
    countCast: (expr) => `${expr}::bigint`,
  };
}
