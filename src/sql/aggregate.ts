// aggregate pushdown: one GROUP BY statement per wire query, spelled through the flavor

import { badRequest } from "../serve/errors";
import type { AggregateSourceQueryWire } from "../wire/schemas";
import type { DateGrain, SourceRow } from "../wire/vocabulary";
import type { Column, Table, WireKind } from "./catalog";
import { Binder, buildWhere } from "./filters";
import type { SqlContext, SqlFlavor } from "./flavor";
import type { Row } from "./sql-connector";
import { buildFrom, requireColumn, requireTable } from "./sql-util";
import { renderValue } from "./values";

export type OutColumn = { key: string; expr: string; wire: WireKind };

type Resolved = { alias: string; column: Column };

// resolve a field name to a hop's projected field (by `as`), else a base column
function resolveField(
  ctx: SqlContext,
  query: AggregateSourceQueryWire,
  base: Table,
  aliases: ReadonlyMap<string, string>,
  name: string,
): Resolved {
  for (const join of query.joins ?? []) {
    for (const jf of join.fields) {
      if ((jf.as ?? jf.field) === name) {
        const alias = aliases.get(join.toTable);
        if (!alias) throw badRequest(`join '${join.toTable}' was not aliased`);
        return {
          alias,
          column: requireColumn(requireTable(ctx, join.toTable), jf.field),
        };
      }
    }
  }
  return { alias: "t0", column: requireColumn(base, name) };
}

// group-key expression; grain buckets to ISO period-start, raw text is byte-pinned against locale merges
function groupExpression(
  flavor: SqlFlavor,
  alias: string,
  column: Column,
  grain: DateGrain | undefined,
  pinned: boolean,
): { expr: string; wire: WireKind } {
  const c = `${alias}.${flavor.quoteIdent(column.name)}`;
  if (grain) return { expr: flavor.dateTrunc(grain, c), wire: "text" };
  switch (column.wire) {
    case "decimal":
      return { expr: flavor.castText(c), wire: "decimal" };
    case "date":
      return { expr: flavor.renderDate(c), wire: "date" };
    case "datetime":
      return { expr: flavor.renderDatetime(c), wire: "datetime" };
    case "text":
      return { expr: pinned ? flavor.bytePin(c) : c, wire: "text" };
    default:
      return { expr: c, wire: column.wire };
  }
}

const NUMERIC: ReadonlySet<WireKind> = new Set(["int", "decimal"]);
const ORDERABLE: ReadonlySet<WireKind> = new Set(["int", "decimal", "date", "datetime", "text"]);

function colRef(flavor: SqlFlavor, alias: string, column: Column): string {
  return `${alias}.${flavor.quoteIdent(column.name)}`;
}

// null declines this aggregate (serve answers 204); a wrong number is never legal
function measureExpression(
  flavor: SqlFlavor,
  alias: string,
  column: Column | null,
  fn: string,
  pinned: boolean,
): { expr: string; wire: WireKind } | null {
  const ref = column ? colRef(flavor, alias, column) : null;
  if (fn === "count") {
    if (column && column.wire === "text_array") return null;
    return { expr: flavor.countCast(ref ? `COUNT(${ref})` : "COUNT(*)"), wire: "int" };
  }
  if (!column || !ref) throw badRequest(`measure '${fn}' requires a field`);
  if (fn === "count_distinct") {
    if (column.wire === "text_array") return null;
    const key = column.wire === "text" && pinned ? flavor.bytePin(ref) : ref;
    return { expr: flavor.countCast(`COUNT(DISTINCT ${key})`), wire: "int" };
  }
  if (fn === "sum") {
    if (!NUMERIC.has(column.wire)) return null;
    return { expr: flavor.castText(`SUM(${ref})`), wire: "decimal" };
  }
  if (fn === "min" || fn === "max") {
    if (!ORDERABLE.has(column.wire)) return null;
    const agg = fn.toUpperCase();
    switch (column.wire) {
      case "decimal":
        return { expr: flavor.castText(`${agg}(${ref})`), wire: "decimal" };
      case "date":
        return { expr: flavor.renderDate(`${agg}(${ref})`), wire: "date" };
      case "datetime":
        return { expr: flavor.renderDatetime(`${agg}(${ref})`), wire: "datetime" };
      case "text":
        return { expr: `${agg}(${pinned ? flavor.bytePin(ref) : ref})`, wire: "text" };
      default:
        return { expr: `${agg}(${ref})`, wire: "int" };
    }
  }
  return null;
}

// AggregateSourceQuery → one GROUP BY statement, or null to decline the whole aggregate
export function buildAggregate(
  ctx: SqlContext,
  query: AggregateSourceQueryWire,
  limit: number,
): { sql: string; params: unknown[]; columns: OutColumn[] } | null {
  const base = requireTable(ctx, query.table);
  // a hop onto a non-unique key can multiply base rows and inflate every measure;
  // only unique-keyed same-source joins push down, anything else declines
  for (const join of query.joins ?? []) {
    if (!requireColumn(requireTable(ctx, join.toTable), join.toField).unique) return null;
  }
  const stringFields = new Set(query.stringFields);
  const binder = new Binder(ctx.flavor);
  const columns: OutColumn[] = [];
  const groupExprs: string[] = [];
  const { from, aliases } = buildFrom(ctx, query, base);

  for (const group of query.groupBy) {
    const { alias, column } = resolveField(ctx, query, base, aliases, group.field);
    const { expr, wire } = groupExpression(
      ctx.flavor,
      alias,
      column,
      group.grain,
      stringFields.has(group.field),
    );
    columns.push({ key: group.as, expr, wire });
    groupExprs.push(expr);
  }

  for (const measure of query.measures) {
    const resolved = measure.field
      ? resolveField(ctx, query, base, aliases, measure.field)
      : null;
    const pinned = measure.field ? stringFields.has(measure.field) : false;
    const built = measureExpression(
      ctx.flavor,
      resolved?.alias ?? "t0",
      resolved?.column ?? null,
      measure.fn,
      pinned,
    );
    if (!built) return null;
    columns.push({ key: measure.as, expr: built.expr, wire: built.wire });
  }

  const where = buildWhere(ctx, base, query.and, query.or, binder);
  const select = columns.map((c) => `${c.expr} AS ${ctx.flavor.quoteIdent(c.key)}`).join(", ");
  const groupBy = groupExprs.length > 0 ? `GROUP BY ${groupExprs.join(", ")}` : "";
  const parts = [`SELECT ${select}`, `FROM ${from}`, where, groupBy, `LIMIT ${limit}`];
  return {
    sql: parts.filter(Boolean).join(" "),
    params: binder.params,
    columns,
  };
}

export function renderAggregateRows(rows: Row[], columns: OutColumn[]): SourceRow[] {
  return rows.map((row) => {
    const out: SourceRow = {};
    for (const c of columns) out[c.key] = renderValue(row[c.key], c.wire);
    return out;
  });
}
