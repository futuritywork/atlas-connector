import { defineCapability, type CapabilityDoc, type Pushdown } from "@futurity/atlas-connector";

// YOUR CODE HERE: the ops your upstream request builder can send, per entity or per field
// {} pushes nothing and Atlas narrows itself; widen a field only once query() puts it on the wire
export const PUSHDOWN: Pushdown = {
  entities: {
    companies: { fields: { id: ["eq", "in"], created_at: ["gte", "lte"] } },
  },
  sort: "none",
  offset: false,
  join: false,
};

// the served atlas.json; emitted from PUSHDOWN, so an advertised op is one you push
export const ATLAS_JSON: CapabilityDoc = defineCapability({
  slug: "my-atlas-connector",
  pushdown: PUSHDOWN,
  limits: { pageSizeMax: 100, concurrency: 1 }, // YOUR CODE HERE: the vendor's own ceilings; a cursor api is concurrency 1
  keysEnforced: false, // true only where the upstream rejects a duplicate in a field you declare unique
  dateBucket: false, // true only once aggregate() buckets a date field upstream
  credentialSchema: [ // YOUR CODE HERE: what a tenant types to reach their instance; help is markdown under the label
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
});
