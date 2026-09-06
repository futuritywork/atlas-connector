import { serve } from "@futurity/atlas-connector";
import { StampsConnector } from "./connector";

const token = process.env.ATLAS_CONNECTOR_TOKEN;
if (!token || token.length < 32) {
  throw new Error("ATLAS_CONNECTOR_TOKEN must be set, 32+ chars");
}

serve(new StampsConnector(), {
  token,
  port: Number(process.env.CONNECTOR_PORT ?? 4100),
});
