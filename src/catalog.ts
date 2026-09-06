import type { DiscoveredField } from "./wire/schemas";

export type Field = Pick<DiscoveredField, "name" | "type" | "nullable" | "unique"> & {
  description: DiscoveredField["sourceDescription"];
};

export function field<const Name extends string, const Type extends Field["type"]>(
  name: Name,
  type: Type,
  options: Partial<Pick<Field, "nullable" | "unique" | "description">> = {},
): Field & { name: Name; type: Type } {
  return {
    name,
    type,
    nullable: options.nullable ?? false,
    unique: options.unique ?? false,
    description: options.description ?? "",
  };
}

type CatalogTable = { name: string; columns: Field[] };

export type Catalog<T extends CatalogTable = CatalogTable> = {
  tables: T[];
  getTable(name: string): T | undefined;
  getColumn(table: T, name: string): T["columns"][number] | undefined;
};

export function defineCatalog<T extends CatalogTable>(tables: T[]): Catalog<T> {
  if (new Set(tables.map((table) => table.name)).size !== tables.length) {
    throw new Error("duplicate catalog table name");
  }
  for (const table of tables) {
    if (new Set(table.columns.map((column) => column.name)).size !== table.columns.length) {
      throw new Error(`duplicate catalog field name on '${table.name}'`);
    }
  }
  return {
    tables,
    getTable: (name) => tables.find((table) => table.name === name),
    getColumn: (table, name) => table.columns.find((column) => column.name === name),
  };
}

export function fieldTypes(fields: readonly Pick<Field, "name" | "type">[]): Record<string, Field["type"]> {
  return Object.fromEntries(fields.map(({ name, type }) => [name, type]));
}

export function discoverFields(fields: readonly Field[]): DiscoveredField[] {
  return fields.map(({ name, type, nullable, unique, description }) => ({
    name,
    sourceColumn: name,
    type,
    nullable,
    unique,
    samples: [],
    sourceDescription: description,
  }));
}
