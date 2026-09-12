import { unsupported } from "../serve/errors";
import type { Filter, Op } from "../wire/vocabulary";
import type { Column, Table } from "./catalog";
import type { SqlContext, SqlFlavor } from "./flavor";
import { requireColumn } from "./sql-util";

const COMPARATORS = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

/** accumulates positional binds; the returned placeholder is the only way a value reaches sql. */
export class Binder {
  readonly params: unknown[] = [];
  constructor(private readonly flavor: SqlFlavor) {}
  bind(value: unknown): string {
    this.params.push(value);
    return this.flavor.placeholder(this.params.length);
  }
}

function assertAdvertised(ctx: SqlContext, op: Op): void {
  if (!ctx.operators.has(op)) {
    throw unsupported(`operator '${op}' is not advertised by this connector`);
  }
}

// drivers bind JS numbers as floats (folds past 2^53); bind text + numeric cast to compare exact
function boundParam(ctx: SqlContext, column: Column, value: unknown, binder: Binder): string {
  const numeric = column.wire === "decimal" || column.wire === "int";
  if (numeric && value !== null) {
    return ctx.flavor.numericParam(binder.bind(String(value)));
  }
  return binder.bind(value);
}

// % and _ are LIKE wildcards and the escaping backslash escapes itself
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function renderLike(ctx: SqlContext, col: string, pattern: string, binder: Binder): string {
  return `${ctx.flavor.castText(col)} LIKE ${binder.bind(pattern)} ${ctx.flavor.likeEscape}`;
}

function renderFilter(ctx: SqlContext, table: Table, filter: Filter, binder: Binder): string {
  assertAdvertised(ctx, filter.op);
  const column = requireColumn(table, filter.field);
  // t0-qualified so a hop column of the same name can never make the reference ambiguous
  const col = `t0.${ctx.flavor.quoteIdent(column.name)}`;

  switch (filter.op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return `${col} ${COMPARATORS[filter.op]} ${boundParam(ctx, column, filter.value, binder)}`;
    case "in": {
      // an empty set matches nothing; a null-only set already reached here as empty
      if (filter.values.length === 0) return "1 = 0";
      const placeholders = filter.values.map((value) => boundParam(ctx, column, value, binder));
      return `${col} IN (${placeholders.join(", ")})`;
    }
    case "nin": {
      // atlas nin keeps null rows, and an empty set excludes nothing
      if (filter.values.length === 0) return "1 = 1";
      const placeholders = filter.values.map((value) => boundParam(ctx, column, value, binder));
      return `(${col} NOT IN (${placeholders.join(", ")}) OR ${col} IS NULL)`;
    }
    case "includes":
      return renderLike(ctx, col, `%${escapeLike(String(filter.value))}%`, binder);
    case "startswith":
      return renderLike(ctx, col, `${escapeLike(String(filter.value))}%`, binder);
    case "contains": {
      if (!ctx.flavor.arrayContains) {
        throw unsupported(`operator 'contains' is not supported by this dialect`);
      }
      if (column.wire !== "text_array") {
        throw unsupported(`operator 'contains' requires an array column, got '${column.wire}'`);
      }
      return ctx.flavor.arrayContains(binder.bind(filter.value), col);
    }
    case "isnull":
      return `${col} IS NULL`;
    case "notnull":
      return `${col} IS NOT NULL`;
  }
}

/** and[] conjoined, or[][] as DNF, the whole block one further conjunct. */
export function buildWhere(
  ctx: SqlContext,
  table: Table,
  and: Filter[],
  or: Filter[][] | undefined,
  binder: Binder,
): string {
  const groups: string[] = and.map((filter) => renderFilter(ctx, table, filter, binder));

  if (or && or.length > 0) {
    const disjuncts = or.map((group) => {
      const inner = group.map((filter) => renderFilter(ctx, table, filter, binder));
      return `(${inner.join(" AND ")})`;
    });
    groups.push(`(${disjuncts.join(" OR ")})`);
  }

  return groups.length > 0 ? `WHERE ${groups.join(" AND ")}` : "";
}
