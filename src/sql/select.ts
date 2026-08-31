import type { SourceQueryWire } from "../wire/schemas";
import type { SourceRow } from "../wire/vocabulary";
import { badRequest } from "../serve/errors";
import type { Column, Table } from "./catalog";
import { Binder, buildWhere } from "./filters";
import type { SqlContext } from "./flavor";
import { type AliasMap, buildFrom, requireColumn, requireTable, tableRef } from "./sql-util";
import { projectExpression, renderValue } from "./values";

export type ProjectedColumn = { key: string; expr: string; column: Column };

// projectExpression quotes only the bare column, so an aliased hop field re-qualifies it
function aliasedProjection(ctx: SqlContext, alias: string, column: Column): string {
  const quoted = ctx.flavor.quoteIdent(column.name);
  const bare = projectExpression(ctx.flavor, column.name, column.wire);
  return bare.replace(quoted, `${alias}.${quoted}`);
}

function buildProjection(
  ctx: SqlContext,
  query: SourceQueryWire,
  base: Table,
  aliases: AliasMap,
): ProjectedColumn[] {
  const projected: ProjectedColumn[] = [];

  for (const field of query.fields) {
    const column = requireColumn(base, field);
    projected.push({
      key: field,
      expr: aliasedProjection(ctx, "t0", column),
      column,
    });
  }

  for (const join of query.joins ?? []) {
    const alias = aliases.get(join.toTable);
    const target = requireTable(ctx, join.toTable);
    if (!alias) throw badRequest(`join '${join.toTable}' was not aliased`);
    for (const jf of join.fields) {
      const column = requireColumn(target, jf.field);
      const key = jf.as ?? jf.field;
      projected.push({ key, expr: aliasedProjection(ctx, alias, column), column });
    }
  }

  if (projected.length === 0) throw badRequest("query selects no fields");
  return projected;
}

function buildOrderBy(ctx: SqlContext, query: SourceQueryWire, base: Table): string {
  if (query.sort.length === 0) return "";
  const terms = query.sort.map((sort) => {
    const column = requireColumn(base, sort.field);
    const c = `t0.${ctx.flavor.quoteIdent(column.name)}`;
    const ordered = sort.collate && column.type === "string" ? ctx.flavor.bytePin(c) : c;
    const direction = sort.dir === "asc" ? "ASC" : "DESC";
    return `${ordered} ${direction} NULLS LAST`;
  });
  return `ORDER BY ${terms.join(", ")}`;
}

function buildWindow(query: SourceQueryWire): string {
  const clauses: string[] = [];
  if (query.limit !== undefined) clauses.push(`LIMIT ${query.limit}`);
  if (query.offset !== undefined) clauses.push(`OFFSET ${query.offset}`);
  return clauses.join(" ");
}

// SourceQuery → one SELECT, plus the column list needed to render every row's wire values
export function buildSelect(
  ctx: SqlContext,
  query: SourceQueryWire,
): {
  sql: string;
  params: unknown[];
  columns: ProjectedColumn[];
} {
  const base = requireTable(ctx, query.table);
  const binder = new Binder(ctx.flavor);
  const { from, aliases } = buildFrom(ctx, query, base);
  const columns = buildProjection(ctx, query, base, aliases);
  const where = buildWhere(ctx, base, query.and, query.or, binder);
  const select = columns.map((c) => `${c.expr} AS ${ctx.flavor.quoteIdent(c.key)}`).join(", ");
  const parts = [
    `SELECT ${select}`,
    `FROM ${from}`,
    where,
    buildOrderBy(ctx, query, base),
    buildWindow(query),
  ];
  return {
    sql: parts.filter(Boolean).join(" "),
    params: binder.params,
    columns,
  };
}

// count ignores sort/limit/offset/fields — none of them change what matches
export function buildCount(
  ctx: SqlContext,
  query: Pick<SourceQueryWire, "table" | "and" | "or">,
): { sql: string; params: unknown[] } {
  const base = requireTable(ctx, query.table);
  const binder = new Binder(ctx.flavor);
  const where = buildWhere(ctx, base, query.and, query.or, binder);
  const count = ctx.flavor.countCast("COUNT(*)");
  const sql = `SELECT ${count} AS count FROM ${tableRef(ctx, base.name)} AS t0 ${where}`.trim();
  return { sql, params: binder.params };
}

export function renderRows(
  rows: Record<string, unknown>[],
  columns: ProjectedColumn[],
): SourceRow[] {
  return rows.map((row) => {
    const out: SourceRow = {};
    for (const c of columns) out[c.key] = renderValue(row[c.key], c.column.wire);
    return out;
  });
}
