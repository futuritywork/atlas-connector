// discovery: one aggregate scan per catalog table plus a small per-column sample pull

import type { DiscoveredField, DiscoveredTable, DiscoveryAnswer } from "../wire/schemas";
import type { Column, Table } from "./catalog";
import type { SqlContext, SqlFlavor } from "./flavor";
import { firstRow, type SqlRunner } from "./probes";
import { tableRef } from "./sql-util";
import { projectExpression, renderValue } from "./values";

const DISCOVERY_SAMPLES = 5;

function statMinMax(flavor: SqlFlavor, column: Column): { min: string; max: string } | null {
  const c = flavor.quoteIdent(column.name);
  switch (column.wire) {
    case "text":
      return { min: `MIN(${flavor.bytePin(c)})`, max: `MAX(${flavor.bytePin(c)})` };
    case "decimal":
    case "int":
      return { min: flavor.castText(`MIN(${c})`), max: flavor.castText(`MAX(${c})`) };
    case "date":
      return { min: flavor.renderDate(`MIN(${c})`), max: flavor.renderDate(`MAX(${c})`) };
    case "datetime":
      return {
        min: flavor.renderDatetime(`MIN(${c})`),
        max: flavor.renderDatetime(`MAX(${c})`),
      };
    default:
      return null; // arrays have no scalar min/max
  }
}

export async function discoverTable(
  ctx: SqlContext,
  run: SqlRunner,
  table: Table,
): Promise<DiscoveredTable> {
  const q = (name: string) => ctx.flavor.quoteIdent(name);
  const t = tableRef(ctx, table.name);
  const selections: string[] = [`COUNT(*) AS ${q("rows")}`];
  table.columns.forEach((column, i) => {
    const c = q(column.name);
    selections.push(`COUNT(${c}) AS nn_${i}`, `COUNT(DISTINCT ${c}) AS d_${i}`);
    const mm = statMinMax(ctx.flavor, column);
    if (mm) selections.push(`${mm.min} AS min_${i}`, `${mm.max} AS max_${i}`);
  });
  const agg = firstRow(await run(`SELECT ${selections.join(", ")} FROM ${t}`, []));
  const rows = Number(agg.rows);

  const fields: DiscoveredField[] = [];
  for (const [i, column] of table.columns.entries()) {
    const nonNull = Number(agg[`nn_${i}`]);
    const sampleRows = await run(
      `SELECT ${projectExpression(ctx.flavor, column.name, column.wire)} AS s FROM ${t} WHERE ${q(column.name)} IS NOT NULL LIMIT ${DISCOVERY_SAMPLES}`,
      [],
    );
    const min = agg[`min_${i}`];
    const max = agg[`max_${i}`];
    fields.push({
      name: column.name,
      sourceColumn: column.name,
      type: column.type,
      nullable: column.nullable,
      unique: column.unique,
      samples: sampleRows.map((r) => renderValue(r.s, column.wire)),
      sourceDescription: column.description,
      stats: {
        nullPercent: rows > 0 ? ((rows - nonNull) / rows) * 100 : 0,
        distinctCount: Number(agg[`d_${i}`]),
        ...(min != null ? { min: String(min) } : {}),
        ...(max != null ? { max: String(max) } : {}),
      },
    });
  }

  return {
    name: table.name,
    sourceDescription: table.description,
    rowCount: rows,
    storesRows: true,
    primaryKey: table.primaryKey,
    foreignKeys: table.foreignKeys,
    fields,
  };
}

export async function discovery(ctx: SqlContext, run: SqlRunner): Promise<DiscoveryAnswer> {
  const tables: DiscoveredTable[] = [];
  for (const table of ctx.catalog.tables) tables.push(await discoverTable(ctx, run, table));
  return { tables, warnings: [] };
}
