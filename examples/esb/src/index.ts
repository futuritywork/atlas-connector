import { serve } from "@futurity/atlas-connector";
import { EsbCoreConnector } from "./connector";
import { parseEsbConfig } from "./schemas";

// credentials arrive on each request; only the port and the bearer come from the environment
const CONFIG = parseEsbConfig(process.env);

const server = serve(new EsbCoreConnector(), {
  token: CONFIG.bearerToken,
  port: CONFIG.port,
});

console.log(`ESB Core Atlas connector at ${server.url}`);
