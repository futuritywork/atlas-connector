// the served atlas.json; the SDK fills `endpoints` from this connector's methods
// pushdown comes from the catalog's param map, so an advertised op is one query() sends
import { defineCapability, type CapabilityDoc } from "@futurity/atlas-connector";
import { esbPushdown } from "./helpers/pushdown";

export const CAPABILITY: CapabilityDoc = defineCapability({
  slug: "esb-core",
  pushdown: esbPushdown(),
  limits: {
    pageSizeMax: 1_000, // this walk's page; ESB caps no limit (limit=100000 answered)
    concurrency: 4,
  },
  keysEnforced: false, // a document number is null until ESB authorises the row
  dateBucket: false,
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
});
