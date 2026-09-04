import { createApp } from "@futurity/atlas-connector";
import { Elysia } from "elysia";
import { LarkConnector } from "./lark/src/connector";
import { StampsConnector } from "./stamps/src/connector";

// Brightline stays off public hosts because it pools to any databaseUrl a caller sends.
const CONNECTORS = [new LarkConnector(), new StampsConnector()];

const token = process.env.ATLAS_CONNECTOR_TOKEN;
if (!token) throw new Error("ATLAS_CONNECTOR_TOKEN must be set");

const port = Number(process.env.PORT ?? 4100);
const prefixes = CONNECTORS.map((connector) => `/${connector.slug}`);

const app = new Elysia().get("/", () => ({ connectors: prefixes }));
for (const connector of CONNECTORS) {
  app.group(`/${connector.slug}`, (group) => group.use(createApp(connector, { token })));
}

app.listen({ port });
console.log(`connectors at http://localhost:${port}: ${prefixes.join(" ")}`);
