// derived atlas.json: the builders provably render everything advertised here, so the
// doc cannot promise an op the flavor and catalog cannot spell

import type { AtlasJson } from "../wire/atlas-json";
import { type Op, OPS } from "../wire/vocabulary";
import type { Catalog } from "./catalog";
import type { SqlFlavor } from "./flavor";

export function sqlCapability(opts: {
  slug: string;
  catalog: Catalog;
  flavor: SqlFlavor;
  enforcesDeclaredKeys: boolean;
  overrides?: Partial<AtlasJson["capabilities"]>;
}): AtlasJson {
  const hasArrayColumn = opts.catalog.tables.some((table) =>
    table.columns.some((column) => column.wire === "text_array"),
  );
  // `contains` is real array membership; without a spelling and a column it is a lie
  const containsRenderable = opts.flavor.arrayContains !== undefined && hasArrayColumn;
  const operators: Op[] = OPS.filter((op) => op !== "contains" || containsRenderable);
  return {
    protocolVersion: 1,
    slug: opts.slug,
    capabilities: {
      operators,
      dateBucket: true,
      sort: "multi",
      offset: true,
      count: "server",
      join: true,
      enforcesDeclaredKeys: opts.enforcesDeclaredKeys,
      probeConcurrency: 4,
      cheapProbes: false,
      ...opts.overrides,
    },
    endpoints: ["aggregate"],
  };
}
