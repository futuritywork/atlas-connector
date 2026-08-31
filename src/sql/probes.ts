// probe sql, parameterized behind the flavor. every probe groups and joins on the bare
// column, so it counts as one exactly what this source's `=` treats as one

import { DUP_SAMPLE_CAP, NEAR_UNIQUE_MIN_SHARE, ORPHAN_SAMPLE_CAP } from "../kit/probe-math";
import type {
  ColumnCountsProbe,
  ColumnDuplicates,
  CountExactRequest,
  GrainProbe,
  LinkProbe,
  ProbeColumnsRequest,
  ProbeGrainRequest,
  ProbeLinkRequest,
  SampleKeyValuesRequest,
  TableColumnsProbe,
} from "../wire/schemas";
import type { Column } from "./catalog";
import type { SqlContext } from "./flavor";
import type { Row } from "./sql-connector";
import { requireColumn, requireTable, tableRef } from "./sql-util";
import { projectExpression } from "./values";

export type SqlRunner = (sql: string, params: unknown[]) => Promise<Row[]>;

// an aggregate select always returns exactly one row; anything else is a driver fault
export function firstRow(rows: Row[]): Row {
  const row = rows[0];
  if (!row) throw new Error("aggregate query returned no rows");
  return row;
}

export async function probeColumns(
  ctx: SqlContext,
  run: SqlRunner,
  req: ProbeColumnsRequest,
): Promise<TableColumnsProbe> {
  const q = (name: string) => ctx.flavor.quoteIdent(name);
  const base = requireTable(ctx, req.table);
  const cols = req.columns.map((name) => requireColumn(base, name));
  const t = tableRef(ctx, base.name);

  const selections = cols.flatMap((c, i) => [
    `COUNT(${q(c.name)}) AS nn_${i}`,
    `COUNT(DISTINCT ${q(c.name)}) AS d_${i}`,
  ]);
  const agg = firstRow(
    await run(`SELECT COUNT(*) AS ${q("rows")}, ${selections.join(", ")} FROM ${t}`, []),
  );

  const result: Record<string, ColumnCountsProbe> = {};
  for (const [i, column] of cols.entries()) {
    const nonNull = Number(agg[`nn_${i}`]);
    const distinct = Number(agg[`d_${i}`]);
    // an empty column lands here too: 0 === 0
    if (distinct === nonNull) {
      result[column.name] = {
        nonNull,
        distinct,
        duplicates: { valueCount: 0, maxMultiplicity: 1 },
      };
      continue;
    }
    // near-unique: enumerate the blemishes promotion will want; below it the distinct count already refutes the key
    if (distinct >= nonNull * NEAR_UNIQUE_MIN_SHARE) {
      result[column.name] = {
        nonNull,
        distinct,
        duplicates: await enumerateDuplicates(ctx, run, t, column),
      };
    } else {
      result[column.name] = { nonNull, distinct, duplicates: null };
    }
  }
  return { rows: Number(agg.rows), columns: result };
}

async function enumerateDuplicates(
  ctx: SqlContext,
  run: SqlRunner,
  t: string,
  column: Column,
): Promise<ColumnDuplicates> {
  const c = ctx.flavor.quoteIdent(column.name);
  const agg = firstRow(
    await run(
      `
    SELECT COALESCE(SUM(CASE WHEN cnt > 1 THEN 1 ELSE 0 END), 0) AS dupvals,
           COALESCE(MAX(cnt), 0) AS maxmult
    FROM (SELECT ${c} AS v, COUNT(*) AS cnt FROM ${t} WHERE ${c} IS NOT NULL GROUP BY ${c}) s`,
      [],
    ),
  );
  const valueCount = Number(agg.dupvals);
  // the byte-order sort runs in an outer query where `v` is a real column of the subquery,
  // so the pin cannot turn a bare ORDER BY alias back into a column reference
  const rows = await run(
    `
    SELECT v FROM (
      SELECT MIN(${ctx.flavor.castText(c)}) AS v FROM ${t} WHERE ${c} IS NOT NULL
      GROUP BY ${c} HAVING COUNT(*) > 1
    ) s ORDER BY ${ctx.flavor.bytePin("v")} LIMIT ${DUP_SAMPLE_CAP}`,
    [],
  );
  const samples = rows.map((r) => String(r.v)).filter(Boolean);
  return {
    valueCount,
    maxMultiplicity: Math.max(Number(agg.maxmult), 1),
    ...(samples.length > 0 ? { samples } : {}),
  };
}

// orphan = a non-null from-value with no match; the target is collapsed to distinct first so a
// duplicated to-value can neither deflate nor inflate the count
export async function probeLink(
  ctx: SqlContext,
  run: SqlRunner,
  req: ProbeLinkRequest,
): Promise<LinkProbe> {
  const from = requireTable(ctx, req.fromTable);
  const to = requireTable(ctx, req.toTable);
  const fc = ctx.flavor.quoteIdent(requireColumn(from, req.fromColumn).name);
  const tc = ctx.flavor.quoteIdent(requireColumn(to, req.toColumn).name);
  const joined = `${tableRef(ctx, from.name)} f
    LEFT JOIN (SELECT DISTINCT ${tc} FROM ${tableRef(ctx, to.name)}) t ON f.${fc} = t.${tc}`;
  const orphaned = `f.${fc} IS NOT NULL AND t.${tc} IS NULL`;

  const agg = firstRow(
    await run(
      `
    SELECT COUNT(f.${fc}) AS from_non_null,
           SUM(CASE WHEN ${orphaned} THEN 1 ELSE 0 END) AS orphan_count
    FROM ${joined}`,
      [],
    ),
  );
  const fromNonNull = Number(agg.from_non_null);
  const orphanCount = Number(agg.orphan_count ?? 0);

  const orphanSamples =
    orphanCount > 0
      ? (
          await run(
            `
          SELECT v FROM (
            SELECT DISTINCT ${ctx.flavor.castText(`f.${fc}`)} AS v FROM ${joined} WHERE ${orphaned}
          ) s ORDER BY ${ctx.flavor.bytePin("v")} LIMIT ${ORPHAN_SAMPLE_CAP}`,
            [],
          )
        ).map((r) => String(r.v))
      : [];

  return {
    fromNonNull,
    orphanCount,
    orphanRate: fromNonNull > 0 ? orphanCount / fromNonNull : 0,
    orphanSamples,
  };
}

export async function probeGrain(
  ctx: SqlContext,
  run: SqlRunner,
  req: ProbeGrainRequest,
): Promise<GrainProbe> {
  const base = requireTable(ctx, req.table);
  const c = ctx.flavor.quoteIdent(requireColumn(base, req.column).name);
  const agg = firstRow(
    await run(
      `
    SELECT COUNT(*) AS ${ctx.flavor.quoteIdent("rows")}, COUNT(${c}) AS non_null, COUNT(DISTINCT ${c}) AS distinct_count
    FROM ${tableRef(ctx, base.name)}`,
      [],
    ),
  );
  return {
    rows: Number(agg.rows),
    distinct: Number(agg.distinct_count),
    nonNull: Number(agg.non_null),
  };
}

// sql COUNT(*) is exact, so null (the "source only approximates" answer) never occurs here
export async function countExact(
  ctx: SqlContext,
  run: SqlRunner,
  req: CountExactRequest,
): Promise<number> {
  const base = requireTable(ctx, req.table);
  const agg = firstRow(
    await run(
      `SELECT ${ctx.flavor.countCast("COUNT(*)")} AS count FROM ${tableRef(ctx, base.name)}`,
      [],
    ),
  );
  return Number(agg.count);
}

// sorted distinct head as text: numeric/temporal by magnitude, text by byte order
export async function sampleKeyValues(
  ctx: SqlContext,
  run: SqlRunner,
  req: SampleKeyValuesRequest,
): Promise<string[]> {
  const base = requireTable(ctx, req.table);
  const column = requireColumn(base, req.column);
  const c = ctx.flavor.quoteIdent(column.name);
  const key = column.type === "string" ? ctx.flavor.bytePin(c) : c;
  const value =
    column.type === "string"
      ? ctx.flavor.bytePin(c)
      : projectExpression(ctx.flavor, column.name, column.wire);
  const rows = await run(
    `
    SELECT ${value} AS v FROM ${tableRef(ctx, base.name)} WHERE ${c} IS NOT NULL
    GROUP BY ${key} ORDER BY ${key} LIMIT ${req.limit}`,
    [],
  );
  return rows.map((r) => (r.v == null ? "" : String(r.v))).filter(Boolean);
}
