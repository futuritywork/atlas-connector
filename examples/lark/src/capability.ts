// the served /.well-known/futurity/atlas.json. every op listed is honored: query()
// fetches the pushdown-narrowed scan and then applyFilters the full set, so the whole
// atlas op vocabulary is safe to advertise even though lark pushes only a slice of it.
import { type AtlasJson, OPS } from "@futurity/atlas-connector";

export const ATLAS_JSON: AtlasJson = {
  protocolVersion: 1,
  slug: "lark-base",
  capabilities: {
    operators: [...OPS],
    dateBucket: false,
    sort: "multi", // honored in-memory after the residual filter pass
    offset: true,
    count: "scan", // residual filters force a scan-and-tally; no cheap server count
    join: false, // atlas joins hops locally over record_id / link_record_ids
    enforcesDeclaredKeys: true, // the only declared key is record_id, which lark itself enforces
    probeConcurrency: 2, // bitable rate limit is 20 rps app-wide; probes are full scans
    cheapProbes: false,
  },
  // per tenant: the app credentials and the base they open
  credentialSchema: [
    {
      key: "appId",
      label: "App ID",
      type: "text",
      required: true,
      placeholder: "cli_XXXXXXXXXXXXXXXX",
      help: "Lark Developer Console → your app → **Credentials & Basic Info**, the field labelled **App ID**. Your apps are listed at [open.larksuite.com/app](https://open.larksuite.com/app).",
    },
    {
      key: "appSecret",
      label: "App secret",
      type: "password",
      required: true,
      help: "The **App Secret** on that same **Credentials & Basic Info** page of the [Lark Developer Console](https://open.larksuite.com/app). The app also needs the `bitable:app:readonly` permission.",
    },
    {
      key: "appToken",
      label: "Base app token",
      type: "text",
      required: true,
      placeholder: "bascnXXXXXXXXXXXXXXXXXXXXXX",
      help: "The id in the base's URL, `https://<tenant>.larksuite.com/base/<app_token>`. Add the app to that base as a collaborator first, or it cannot read the tables.",
    },
  ],
  endpoints: [], // aggregate declined: bitable has no server-side group-by
};
