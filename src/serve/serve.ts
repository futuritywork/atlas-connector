import type { Elysia } from "elysia";
import { z } from "zod";
import type { AtlasConnector } from "../connector";
import { AtlasJson, CONNECTOR_ENDPOINTS, type ConnectorEndpoint } from "../wire/atlas-json";
import { bearerGuard } from "./auth";
import { connectorRoutes } from "./routes";

const MIN_TOKEN_LENGTH = 32;
const DEFAULT_PORT = 4100;

export type ServeOptions = {
  token: string; // bearer; boot fails under 32 characters
  port?: number; // default 4100
  hostname?: string;
};

function servedEndpoints(connector: AtlasConnector): ConnectorEndpoint[] {
  return CONNECTOR_ENDPOINTS.filter((name) => connector[name] !== undefined);
}

/** the connector's Elysia app, boot-failing on a short token or a doc that does not parse. */
export function createApp(connector: AtlasConnector, opts: Pick<ServeOptions, "token">): Elysia {
  if (opts.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`bearer token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const doc = AtlasJson.safeParse({ ...connector.capabilities(), endpoints: servedEndpoints(connector) });
  if (!doc.success) {
    throw new Error(`capability document does not parse: ${z.prettifyError(doc.error)}`);
  }

  // erase Elysia's per-route generics; callers only handle/listen/stop, never Eden-infer
  return connectorRoutes(connector, doc.data, bearerGuard(opts.token)) as unknown as Elysia;
}

/** listens and returns the running app with its url and a stop(). */
export function serve(
  connector: AtlasConnector,
  opts: ServeOptions,
): { app: Elysia; url: string; stop(): Promise<void> } {
  const app = createApp(connector, opts);
  app.listen({ port: opts.port ?? DEFAULT_PORT, hostname: opts.hostname });
  // listen assigns the server synchronously; port 0 reads the real one back
  const server = app.server;
  if (!server) throw new Error("elysia listened without a server");
  return {
    app,
    url: `http://${server.hostname}:${server.port}`,
    async stop() {
      await app.stop();
    },
  };
}
