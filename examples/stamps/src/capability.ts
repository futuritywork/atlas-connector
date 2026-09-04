import { type AtlasJson, OPS } from "@futurity/atlas-connector";

export const ATLAS_JSON: AtlasJson = {
  protocolVersion: 1,
  slug: "stamps",
  capabilities: {
    operators: [...OPS],
    dateBucket: false,
    sort: "none",
    offset: false,
    count: "scan",
    join: false,
    enforcesDeclaredKeys: false,
    probeConcurrency: 2,
    cheapProbes: false,
  },
  credentialSchema: [
    {
      key: "merchantToken",
      label: "Merchant token",
      type: "password",
      required: true,
      placeholder: "40-character merchant token",
      help: "Stamps CRM → **Settings → API Settings → Merchant → Token**. See the [Stamps API v4 documentation](https://staging-crm2.stamps.id/api/v4/docs).",
    },
    {
      key: "baseUrl",
      label: "API base URL",
      type: "text",
      required: false,
      placeholder: "https://staging-crm2.stamps.id",
      help: "Optional Stamps staging host. Leave blank for `https://staging-crm2.stamps.id`; the secondary `https://staging-crm.stamps.id` host is also accepted.",
    },
  ],
  endpoints: [],
};
