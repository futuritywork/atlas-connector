import { serve } from "@futurity/atlas-connector";
import { LarkConnector } from "./connector";
import { CONFIG } from "./env";
import { LarkClient } from "./lark-api";

const { url } = serve(new LarkConnector(new LarkClient(CONFIG)), {
  token: CONFIG.bearerToken,
  port: CONFIG.port,
});

console.log(`lark-base connector serving ${CONFIG.appToken} at ${url}`);
