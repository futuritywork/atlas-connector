import { serve } from "@futurity/atlas-connector";
import { EsbCoreConnector } from "./connector";
import { CONFIG } from "./env";

const server = serve(new EsbCoreConnector(), {
  token: CONFIG.bearerToken,
  port: CONFIG.port,
});

console.log(`ESB Core Atlas connector at ${server.url}`);
