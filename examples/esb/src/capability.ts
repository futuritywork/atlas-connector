import { type AtlasJson, OPS } from "@futurity/atlas-connector";

export const ATLAS_JSON: AtlasJson = {
  protocolVersion: 1,
  slug: "esb-core",
  capabilities: {
    operators: OPS.filter((op) => op !== "contains"),
    dateBucket: false,
    sort: "multi",
    offset: true,
    count: "scan",
    join: false,
    enforcesDeclaredKeys: false,
    probeConcurrency: 4,
    cheapProbes: false,
  },
  credentialSchema: [
    {
      key: "username",
      label: "ESB Core API username",
      type: "text",
      required: true,
      placeholder: "Enter your ESB Core API username",
      help: "The username for the ESB Core API account Atlas will use. Use a dedicated, least-privilege account with read access to every entity you want Atlas to discover. Ask your ESB administrator to create or configure the account; see the [ESB Core API documentation](https://developers.esb.co.id/esb-core/).",
    },
    {
      key: "password",
      label: "ESB Core API password",
      type: "password",
      required: true,
      placeholder: "Enter your ESB Core API password",
      help: "The password for the ESB Core API account above. Atlas sends it with connector requests; the connector does not read it from or store it in environment variables.",
    },
  ],
  endpoints: [],
};
