// one declaration of a source's fields, read by both discovery and local filtering, so the two cannot drift

import type { DiscoveredField } from "./wire/schemas";

/** one declared field; `unique` is a real upstream UNIQUE/PK constraint, never sampled distinctness. */
export type Field = Pick<DiscoveredField, "name" | "type" | "nullable" | "unique"> & {
  description: DiscoveredField["sourceDescription"];
};

/** declare a field; `nullable` and `unique` default to false, so set them to match the upstream. */
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

// the minimum a catalog table carries; a connector's own table type extends it with what it needs
type CatalogTable = { name: string; columns: Field[] };

/** the declared tables; a lookup miss answers undefined, so the caller picks 404 table or 422 field. */
export type Catalog<T extends CatalogTable = CatalogTable> = {
  tables: T[];
  getTable(name: string): T | undefined;
  getColumn(table: T, name: string): T["columns"][number] | undefined;
};

const hasDuplicates = (names: string[]) => new Set(names).size !== names.length;

/** duplicate table or field names throw at construction, never at request time. */
export function defineCatalog<T extends CatalogTable>(tables: T[]): Catalog<T> {
  if (hasDuplicates(tables.map((table) => table.name))) throw new Error("duplicate catalog table name");

  const byName = new Map<string, T>();
  for (const table of tables) {
    if (hasDuplicates(table.columns.map((column) => column.name))) {
      throw new Error(`duplicate catalog field name on '${table.name}'`);
    }
    byName.set(table.name, table);
  }

  return {
    tables,
    getTable: (name) => byName.get(name),
    getColumn: (table, name) => table.columns.find((column) => column.name === name),
  };
}

/** the name → atlas type map `applyFilters` and `assertKnownFields` compare a request against. */
export function fieldTypes(fields: readonly Pick<Field, "name" | "type">[]): Record<string, Field["type"]> {
  return Object.fromEntries(fields.map(({ name, type }) => [name, type]));
}

/** the discovery field list; spread a result to change `sourceColumn` or `samples`. */
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
