// the served /.well-known/futurity/atlas.json. every flag is EARNED; start narrow,
// widen only as query() learns to honor it (pushdown or applyFilters, either counts)
import { type AtlasJson, OPS } from "@futurity/atlas-connector";

export const ATLAS_JSON: AtlasJson = {
  protocolVersion: 1,
  slug: "my-atlas-connector",
  capabilities: {
    // YOUR CODE HERE: only ops query() honors, via pushdown or applyFilters
    operators: ["eq", "neq", "isnull", "notnull"],
    dateBucket: false,
    sort: "none",
    offset: false,
    count: "server",
    join: false, // false = Atlas joins hops locally
    enforcesDeclaredKeys: false,
    probeConcurrency: 4,
    cheapProbes: false,
  },
  // YOUR CODE HERE: what a tenant types to reach their own instance. "password" masks the
  // input. these arrive on every request and are never stored here
  credentialSchema: [
    { key: "baseUrl", label: "API base URL", type: "text" },
    { key: "apiKey", label: "API key", type: "password" },
  ],
  endpoints: [], // add "aggregate" only when you override aggregate()
};
