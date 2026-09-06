import { field, type Catalog as CoreCatalog, type Field } from "../catalog";
import type { DiscoveredTable } from "../wire/schemas";
import type { AtlasType } from "../wire/vocabulary";

export { defineCatalog } from "../catalog";

// how a column's storage renders onto the wire; picked so the wire spelling never
// depends on the driver's own decoding of the value
export type WireKind =
  | "int" // integer identity or count; JSON number when safe, text past 2^53
  | "decimal" // cast to exact server-side text, never a JS float
  | "text"
  | "boolean"
  | "date" // rendered YYYY-MM-DD
  | "datetime" // rendered YYYY-MM-DDTHH:MM:SS, UTC
  | "text_array";

export type Column = Field & {
  wire: WireKind;
};

// one declared edge; enforced or not, it is catalog knowledge the orphan probe exists to test
export type CatalogForeignKey = DiscoveredTable["foreignKeys"][number];

export type Table = {
  name: string;
  description: string;
  primaryKey: string[];
  foreignKeys: CatalogForeignKey[];
  columns: Column[];
};

export function col(
  name: string,
  wire: WireKind,
  type: AtlasType,
  opts: Parameters<typeof field>[2] = {},
): Column {
  return {
    ...field(name, type, opts),
    wire,
  };
}

export type Catalog = CoreCatalog<Table>;
