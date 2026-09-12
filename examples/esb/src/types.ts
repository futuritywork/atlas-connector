import type { Field, Op } from "@futurity/atlas-connector";

type EsbFilterParamBase = {
  field: string;
  ops: readonly Op[]; // `in` takes a comma-separated set
  superset?: boolean; // upstream matches wider: a substring, or a day against a datetime
};

// one param, or a from/to pair
export type EsbFilterParam =
  | (EsbFilterParamBase & { param: string })
  | (EsbFilterParamBase & { from: string; to: string });

export type EsbCoreObject = {
  name: string;
  path: string;
  description: string;
  mode: "paged" | "direct";
  pageSize?: number; // a latency budget; ESB caps nothing
  primaryKey?: string;
  filters?: EsbFilterParam[]; // drives both the request params and the capability doc
  sortFields?: string[];
  columns: Field[];
};
