import type { Field } from "@futurity/atlas-connector";

export type EsbCoreObject = {
  name: string;
  path: string;
  description: string;
  mode: "paged" | "direct";
  primaryKey?: string;
  columns: Field[];
};
