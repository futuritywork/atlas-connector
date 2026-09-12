import { Elysia } from "elysia";
import type { z } from "zod";
import type { AtlasConnector } from "../connector";
import {
  type AtlasJson,
  ATLAS_JSON_PATH,
  CONNECTOR_ENDPOINTS,
  type ConnectorEndpoint,
} from "../wire/atlas-json";
import {
  AggregateRequest,
  CardinalityRequest,
  CheckRequest,
  CountRequest,
  DiscoveryRequest,
  LinkHitRateRequest,
  NativeQueryStreamRequest,
  SizeRequest,
} from "../wire/schemas";
import type { SourceRow } from "../wire/vocabulary";
import { ConnectorError } from "./errors";
import { parseBody, withTimeout } from "./http";
import { ndjsonStream } from "./stream";

type StatusSink = { status?: number | string };
type OptionalMethod<E extends ConnectorEndpoint> = NonNullable<AtlasConnector[E]>;

type OptionalRoute<E extends ConnectorEndpoint> = {
  body: z.ZodType<Parameters<OptionalMethod<E>>[0]>;
  answer(result: Awaited<ReturnType<OptionalMethod<E>>>, set: StatusSink): unknown;
};

type ErasedRoute = {
  body: z.ZodType<{ timeoutMs: number }>;
  answer(result: unknown, set: StatusSink): unknown;
};

// 204 declines this one aggregate; a wrong number is never legal
function aggregateAnswer(rows: SourceRow[] | undefined, set: StatusSink): { rows: SourceRow[] } | undefined {
  if (rows === undefined) {
    set.status = 204;
    return undefined;
  }
  return { rows };
}

// exhaustive over ConnectorEndpoint, so a mounted route and a listed endpoint are one set
const OPTIONAL_ROUTES: { [E in ConnectorEndpoint]: OptionalRoute<E> } = {
  size: { body: SizeRequest, answer: (size) => ({ size }) },
  count: { body: CountRequest, answer: (count) => ({ count }) },
  aggregate: { body: AggregateRequest, answer: aggregateAnswer },
  cardinality: { body: CardinalityRequest, answer: (columns) => ({ columns }) },
  linkHitRate: { body: LinkHitRateRequest, answer: (link) => link },
};

export function connectorRoutes(
  connector: AtlasConnector,
  doc: AtlasJson,
  assertBearer: (header: string | undefined) => void,
) {
  const app = new Elysia()
    // every thrown error answers as the envelope, never as a stack
    .onError(({ code, error, set, request }) => {
      const connectorError = ConnectorError.fromCause(error);
      if (connectorError) {
        set.status = connectorError.status;
        return connectorError.body();
      }
      // scanners hit unknown paths constantly; one plain line, no stack
      if (code === "NOT_FOUND") {
        console.warn(`[${connector.slug}] 404 ${request.method} ${new URL(request.url).pathname}`);
        set.status = 404;
        return { error: { code: "not_found", message: "no such route" } };
      }
      // the envelope hides the cause; the operator log keeps it
      console.error(`[${connector.slug}] ${code}`, error);
      if (code === "PARSE") {
        set.status = 400;
        return { error: { code: "bad_request", message: "malformed request body" } };
      }
      set.status = 500;
      return { error: { code: "internal", message: "internal error" } };
    })

    // unauthenticated: the doc carries no customer data, only the capability surface
    .get(ATLAS_JSON_PATH, () => doc)

    .post("/check", async ({ body, headers, set }) => {
      assertBearer(headers.authorization);
      const req = parseBody(CheckRequest, body);
      try {
        await withTimeout(req.timeoutMs, () => connector.check(req));
      } catch (error) {
        const connectorError = ConnectorError.fromCause(error);
        if (connectorError) throw connectorError;
        // check_failed's message reaches the tenant verbatim
        const message = error instanceof Error ? error.message : String(error);
        set.status = 400;
        return { error: { code: "check_failed", message } };
      }
      return { ok: true };
    })

    .post("/discovery", async ({ body, headers }) => {
      assertBearer(headers.authorization);
      const req = parseBody(DiscoveryRequest, body);
      return await withTimeout(req.timeoutMs, () => connector.discovery(req));
    })

    .post("/query", ({ body, headers }) => {
      assertBearer(headers.authorization);
      const req = parseBody(NativeQueryStreamRequest, body);
      // the stream owns its idle/hard deadlines; no outer withTimeout
      const deadlines = { idleTimeoutMs: req.idleTimeoutMs, maxTimeoutMs: req.maxTimeoutMs };
      return ndjsonStream(connector.query(req), deadlines, req);
    });

  for (const name of CONNECTOR_ENDPOINTS) {
    const method = connector[name];
    if (!method) continue;
    // the cast erases only the endpoint pairing, never the shapes checked above
    const route = OPTIONAL_ROUTES[name] as ErasedRoute;
    const call = method.bind(connector) as (request: { timeoutMs: number }) => Promise<unknown>;
    app.post(`/${name}`, async ({ body, headers, set }) => {
      assertBearer(headers.authorization);
      const req = parseBody(route.body, body);
      return await withTimeout(req.timeoutMs, async () => route.answer(await call(req), set));
    });
  }

  return app;
}
