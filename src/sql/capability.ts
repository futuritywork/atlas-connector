import { defineCapability, type Pushdown } from "../kit/pushdown";
import type { CapabilityDoc, ConnectorLimits, CredentialField } from "../wire/atlas-json";
import { OPS } from "../wire/vocabulary";
import type { Catalog } from "./catalog";
import type { SqlFlavor } from "./flavor";

const SQL_LIMITS: ConnectorLimits = { concurrency: 4 };

// only the ops this flavor and catalog can actually spell
function sqlPushdown(catalog: Catalog, flavor: SqlFlavor): Pushdown {
  const hasArrayColumn = catalog.tables.some((table) =>
    table.columns.some((column) => column.wire === "text_array"),
  );
  const containsRenderable = flavor.arrayContains !== undefined && hasArrayColumn;
  const ops = OPS.filter((op) => op !== "contains" || containsRenderable);
  return { ops, sort: "multi", offset: true, join: true };
}

/** the doc a sql connector serves; its operator set is derived from the flavor, never authored. */
export function sqlCapability(opts: {
  slug: string;
  catalog: Catalog;
  flavor: SqlFlavor;
  keysEnforced: boolean;
  credentialSchema: CredentialField[];
  limits?: Partial<ConnectorLimits>;
}): CapabilityDoc {
  return defineCapability({
    slug: opts.slug,
    pushdown: sqlPushdown(opts.catalog, opts.flavor),
    limits: { ...SQL_LIMITS, ...opts.limits },
    keysEnforced: opts.keysEnforced,
    dateBucket: true,
    credentialSchema: opts.credentialSchema,
  });
}
