import type { AtlasType } from "@futurity/atlas-connector";

export type EsbCoreColumn = {
  name: string;
  type: AtlasType;
  nullable: boolean;
  description: string;
};

export type EsbCoreObject = {
  name: string;
  path: string;
  description: string;
  mode: "paged" | "direct";
  primaryKey?: string;
  columns: EsbCoreColumn[];
};
