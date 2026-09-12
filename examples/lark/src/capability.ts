// the served atlas.json; the SDK fills the endpoints from this connector's methods

import { defineCapability, type CapabilityDoc } from "@futurity/atlas-connector";
import { LARK_PUSHDOWN } from "./pushdown";

export const CAPABILITY: CapabilityDoc = defineCapability({
  slug: "lark-base",
  pushdown: LARK_PUSHDOWN,
  limits: {
    pageSizeMax: 500,
    rowsPerTableMax: 20_000, // batch_create answers 1254103 past this
    concurrency: 1, // records/search pages by page_token
  },
  keysEnforced: false, // bitable enforces no key of its own
  dateBucket: false,
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
});
