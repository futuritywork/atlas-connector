import type { EsbCoreObject } from "./types";

export function assertEsbCoreCatalog(catalog: EsbCoreObject[]): void {
  const names = new Set<string>();
  for (const object of catalog) {
    if (names.has(object.name))
      throw new Error(`duplicate ESB Core table '${object.name}'`);
    names.add(object.name);

    const fields = new Set<string>();
    for (const column of object.columns) {
      if (fields.has(column.name)) {
        throw new Error(
          `duplicate ESB Core field '${object.name}.${column.name}'`,
        );
      }
      fields.add(column.name);
    }
    if (object.primaryKey && !fields.has(object.primaryKey)) {
      throw new Error(
        `ESB Core primary key '${object.name}.${object.primaryKey}' is not a declared field`,
      );
    }
  }
}
