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
  // YOUR CODE HERE: what a tenant types to reach their own instance. "password" masks the input, "textarea" fits a pasted key, required: false lets it stay blank.
  // help is markdown under the label: name the exact page in the vendor's ui and link its doc
  credentialSchema: [
    {
      key: "baseUrl",
      label: "API base URL",
      type: "text",
      required: true,
      placeholder: "https://acme.example.com/api/v2",
      help: "The root your instance answers on, with no trailing slash. It is the address in your browser when you are signed in to the vendor's app.",
    },
    {
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
      help: "Vendor console → **Settings → API keys → Create key**. Copy it when it is shown; the console never shows it again.",
    },
  ],
  endpoints: [], // add "aggregate" only when you override aggregate()
};
