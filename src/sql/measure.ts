// counts and joins run on the bare column, so the db's own `=` decides distinctness

import { ORPHAN_SAMPLE_CAP } from "../kit/measure";
import type {
  CardinalityRequest,
  EntitySize,
  LinkHitRate,
  LinkHitRateRequest,
  SizeRequest,
  TableCardinality,
} from "../wire/schemas";
import type { SqlContext } from "./flavor";
import type { Row } from "./sql-connector";
import { requireColumn, requireTable, tableRef } from "./sql-util";

export type SqlRunner = (sql: string, params: unknown[]) => Promise<Row[]>;

// an aggregate always returns one row; none means a driver fault
export function firstRow(rows: Row[]): Row {
  const row = rows[0];
  if (!row) throw new Error("aggregate query returned no rows");
  return row;
}

export async function cardinality(
  ctx: SqlContext,
  run: SqlRunner,
  req: CardinalityRequest,
): Promise<TableCardinality> {
  const base = requireTable(ctx, req.table);
  const columns = req.columns.map((name) => requireColumn(base, name));

  const selections = columns.flatMap((column, i) => {
    const quoted = ctx.flavor.quoteIdent(column.name);
    return [`COUNT(${quoted}) AS nn_${i}`, `COUNT(DISTINCT ${quoted}) AS d_${i}`];
  });
  const sql = `SELECT ${selections.join(", ")} FROM ${tableRef(ctx, base.name)}`;
  const agg = firstRow(await run(sql, []));

  const counts: TableCardinality = {};
  for (const [i, column] of columns.entries()) {
    counts[column.name] = { nonNull: Number(agg[`nn_${i}`]), distinct: Number(agg[`d_${i}`]) };
  }
  return counts;
}

// byte order keeps the sample identical run to run
async function sampleOrphans(
  ctx: SqlContext,
  run: SqlRunner,
  from: { joined: string; orphaned: string; column: string },
): Promise<string[]> {
  const misses = `SELECT DISTINCT ${ctx.flavor.castText(from.column)} AS v FROM ${from.joined} WHERE ${from.orphaned}`;
  const sql = `SELECT v FROM (${misses}) s ORDER BY ${ctx.flavor.bytePin("v")} LIMIT ${ORPHAN_SAMPLE_CAP}`;
  const rows = await run(sql, []);
  return rows.map((row) => String(row.v));
}

// orphan = a non-null from-value with no match in the target
export async function linkHitRate(
  ctx: SqlContext,
  run: SqlRunner,
  req: LinkHitRateRequest,
): Promise<LinkHitRate> {
  const from = requireTable(ctx, req.fromTable);
  const to = requireTable(ctx, req.toTable);
  const fc = ctx.flavor.quoteIdent(requireColumn(from, req.fromColumn).name);
  const tc = ctx.flavor.quoteIdent(requireColumn(to, req.toColumn).name);
  const joined = `${tableRef(ctx, from.name)} f
    LEFT JOIN (SELECT DISTINCT ${tc} FROM ${tableRef(ctx, to.name)}) t ON f.${fc} = t.${tc}`;
  const orphaned = `f.${fc} IS NOT NULL AND t.${tc} IS NULL`;

  const sql = `SELECT COUNT(f.${fc}) AS from_non_null,
           SUM(CASE WHEN ${orphaned} THEN 1 ELSE 0 END) AS orphan_count
    FROM ${joined}`;
  const agg = firstRow(await run(sql, []));
  const fromNonNull = Number(agg.from_non_null);
  const orphanCount = Number(agg.orphan_count ?? 0); // SUM over no rows is NULL

  let orphanSamples: string[] = [];
  if (orphanCount > 0) {
    orphanSamples = await sampleOrphans(ctx, run, { joined, orphaned, column: `f.${fc}` });
  }

  return {
    fromNonNull,
    orphanCount,
    orphanRate: fromNonNull > 0 ? orphanCount / fromNonNull : 0,
    orphanSamples,
  };
}

export async function size(ctx: SqlContext, run: SqlRunner, req: SizeRequest): Promise<EntitySize> {
  const base = requireTable(ctx, req.table);
  const count = ctx.flavor.countCast("COUNT(*)");
  const sql = `SELECT ${count} AS count FROM ${tableRef(ctx, base.name)}`;
  const agg = firstRow(await run(sql, []));
  return { rows: Number(agg.count), exact: true };
}
