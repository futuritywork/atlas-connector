import type { AtlasType } from "../wire/vocabulary";

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

export type Column = {
  name: string;
  wire: WireKind;
  type: AtlasType; // what discovery reports and fieldTypes bind against
  nullable: boolean;
  unique: boolean; // a real db UNIQUE/PK constraint — earns the constraint key tier
  description: string;
};

// one declared edge; enforced or not, it is catalog knowledge the orphan probe exists to test
export type CatalogForeignKey = {
  field: string;
  targetTable: string;
  targetField: string;
};

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
  opts: { nullable?: boolean; unique?: boolean; description?: string } = {},
): Column {
  return {
    name,
    wire,
    type,
    nullable: opts.nullable ?? false,
    unique: opts.unique ?? false,
    description: opts.description ?? "",
  };
}

export type Catalog = {
  tables: Table[];
  getTable(name: string): Table | undefined;
  getColumn(table: Table, name: string): Column | undefined;
};

export function defineCatalog(tables: Table[]): Catalog {
  const byName = new Map(tables.map((table) => [table.name, table]));
  return {
    tables,
    getTable: (name) => byName.get(name),
    getColumn: (table, name) => table.columns.find((column) => column.name === name),
  };
}
