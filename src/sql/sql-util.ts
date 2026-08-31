import { badRequest, unknownEntity } from "../serve/errors";
import type { Column, Table } from "./catalog";
import type { SqlContext } from "./flavor";

// idents come from the catalog, quoted anyway so keyword-like names stay legal; values never travel here
export function quoteIdent(ctx: SqlContext, name: string): string {
  return ctx.flavor.quoteIdent(name);
}

// schema-qualified table reference
export function tableRef(ctx: SqlContext, table: string): string {
  return `${ctx.flavor.quoteIdent(ctx.schema)}.${ctx.flavor.quoteIdent(table)}`;
}

// base table is t0, each hop target t1, t2 …; a hop's fromTable resolves through this map
export type AliasMap = Map<string, string>;

// only the four fields buildFrom reads
type JoinRef = {
  fromTable: string;
  toTable: string;
  fromField: string;
  toField: string;
};

export function requireTable(ctx: SqlContext, name: string): Table {
  const table = ctx.catalog.getTable(name);
  if (!table) throw unknownEntity(`unknown table '${name}'`);
  return table;
}

export function requireColumn(table: Table, field: string): Column {
  const column = table.columns.find((candidate) => candidate.name === field);
  if (!column) {
    throw badRequest(`unknown column '${field}' on table '${table.name}'`);
  }
  return column;
}

// FROM + chained LEFT JOINs; an unmatched row survives with NULL hop fields
export function buildFrom(
  ctx: SqlContext,
  query: { joins?: JoinRef[] },
  base: Table,
): { from: string; aliases: AliasMap } {
  const quote = ctx.flavor.quoteIdent;
  const aliases: AliasMap = new Map([[base.name, "t0"]]);
  let from = `${tableRef(ctx, base.name)} AS t0`;

  (query.joins ?? []).forEach((join, index) => {
    const parentAlias = aliases.get(join.fromTable);
    if (!parentAlias) {
      throw badRequest(`join fromTable '${join.fromTable}' has no prior table`);
    }
    const target = requireTable(ctx, join.toTable);
    const alias = `t${index + 1}`;
    aliases.set(join.toTable, alias);
    requireColumn(requireTable(ctx, join.fromTable), join.fromField);
    requireColumn(target, join.toField);
    const fk = `${parentAlias}.${quote(join.fromField)}`;
    const pk = `${alias}.${quote(join.toField)}`;
    from += ` LEFT JOIN ${tableRef(ctx, join.toTable)} AS ${alias} ON ${fk} = ${pk}`;
  });

  return { from, aliases };
}
