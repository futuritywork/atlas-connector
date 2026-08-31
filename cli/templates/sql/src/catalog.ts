import { col, defineCatalog } from "@futurity/atlas-connector/sql";

// YOUR CODE HERE: declare your tables. wire = how the column's storage crosses the wire
// (int | decimal | text | boolean | date | datetime | text_array); type = what Atlas binds against.
// unique: true only for a REAL db unique/pk constraint.
export const catalog = defineCatalog([
  {
    name: "companies",
    description: "Accounts.",
    primaryKey: ["id"],
    foreignKeys: [],
    columns: [
      col("id", "int", "number", { unique: true }),
      col("name", "text", "string"),
      col("created_at", "datetime", "datetime"),
    ],
  },
]);
