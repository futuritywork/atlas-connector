import type { Elysia } from "elysia";
import { z } from "zod";
import { AtlasConnector } from "../connector";
import { AtlasJson } from "../wire/atlas-json";
import { bearerGuard } from "./auth";
import { connectorRoutes } from "./routes";

export type ServeOptions = {
  token: string; // bearer; boot-fails under 32 chars
  port?: number; // default 4100
  hostname?: string;
};

const MIN_TOKEN_LENGTH = 32;
const DEFAULT_PORT = 4100;

type BaseImplMethod =
  | "aggregate"
  | "profileColumns"
  | "profileLink"
  | "profileGrain"
  | "exactCount"
  | "sampleColumnValues";

// prototype identity: an un-overridden method still resolves to the base impl
function isBaseImpl(connector: AtlasConnector, method: BaseImplMethod): boolean {
  return connector[method] === AtlasConnector.prototype[method];
}

export function createApp(connector: AtlasConnector, opts: Pick<ServeOptions, "token">): Elysia {
  if (opts.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`bearer token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const doc = AtlasJson.safeParse(connector.capability());
  if (!doc.success) {
    throw new Error(`capability document does not parse: ${z.prettifyError(doc.error)}`);
  }

  // an advertised aggregate that always 204s wastes round trips; the reverse never gets called
  const advertised = doc.data.endpoints.includes("aggregate");
  if (advertised && isBaseImpl(connector, "aggregate")) {
    console.warn(`[${connector.slug}] endpoints advertises "aggregate" but aggregate() is the base decline`);
  }
  if (!advertised && !isBaseImpl(connector, "aggregate")) {
    console.warn(`[${connector.slug}] aggregate() is implemented but endpoints omits "aggregate"`);
  }

  const derived = (
    ["profileColumns", "profileLink", "profileGrain", "exactCount", "sampleColumnValues"] as const
  ).filter((method) => isBaseImpl(connector, method));
  if (derived.length > 0) {
    console.log(
      `[${connector.slug}] ${derived.join(", ")} scan through query(); override them for source-side math`,
    );
  }

  // erase Elysia's per-route generics: callers only handle/listen/stop, never Eden-infer
  return connectorRoutes(connector, bearerGuard(opts.token)) as unknown as Elysia;
}

export function serve(
  connector: AtlasConnector,
  opts: ServeOptions,
): { app: Elysia; url: string; stop(): Promise<void> } {
  const app = createApp(connector, opts);
  app.listen({ port: opts.port ?? DEFAULT_PORT, hostname: opts.hostname });
  const hostname = app.server?.hostname ?? opts.hostname ?? "localhost";
  const port = app.server?.port ?? opts.port ?? DEFAULT_PORT;
  return {
    app,
    url: `http://${hostname}:${port}`,
    async stop() {
      await app.stop();
    },
  };
}
