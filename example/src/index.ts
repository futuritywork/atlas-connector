import { serve } from "@futurity/atlas-connector";
import { BrightlineConnector } from "./connector";
import { CONFIG } from "./env";

const { url } = serve(new BrightlineConnector(), {
  token: CONFIG.token,
  port: CONFIG.port,
});

console.log(`brightline connector on ${url} (schema '${CONFIG.schema}', db from CONNECTOR_DATABASE_URL)`);
