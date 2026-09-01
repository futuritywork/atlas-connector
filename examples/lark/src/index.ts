import { serve } from "@futurity/atlas-connector";
import { LarkConnector } from "./connector";
import { CONFIG } from "./env";

const { url } = serve(new LarkConnector(), {
  token: CONFIG.bearerToken,
  port: CONFIG.port,
});

console.log(`lark-base connector at ${url}`);
