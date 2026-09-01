import { serve } from "@futurity/atlas-connector";
import { BrightlineConnector } from "./connector";
import { CONFIG } from "./env";

const { url } = serve(new BrightlineConnector(), {
  token: CONFIG.token,
  port: CONFIG.port,
});

console.log(`brightline connector on ${url} (schema '${CONFIG.schema}'; each request brings its own database url)`);
