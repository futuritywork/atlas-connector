import { Elysia } from "elysia";
import type { AtlasConnector } from "../connector";
import { ATLAS_JSON_PATH } from "../wire/atlas-json";
import {
  AggregateRequest,
  CountExactRequest,
  CountRequest,
  DiscoveryRequest,
  NativeQueryRequest,
  NativeQueryStreamRequest,
  ProbeColumnsRequest,
  ProbeGrainRequest,
  ProbeLinkRequest,
  SampleKeyValuesRequest,
} from "../wire/schemas";
import { ConnectorError } from "./errors";
import { parseBody, withTimeout } from "./http";
import { ndjsonStream } from "./stream";

export function connectorRoutes(
  connector: AtlasConnector,
  assertBearer: (header: string | undefined) => void,
) {
  return (
    new Elysia()
      // map thrown errors to the wire envelope; sanitized 500 / 400, never a raw stack
      .onError(({ code, error, set }) => {
        if (error instanceof ConnectorError) {
          set.status = error.status;
          return error.body();
        }
        const status = code === "PARSE" ? 400 : 500;
        set.status = status;
        return {
          error: {
            code: status === 400 ? "bad_request" : "internal",
            message: status === 400 ? "malformed request body" : "internal error",
          },
        };
      })

      // unauthenticated: no bearer, no customer data — only the capability surface
      .get(ATLAS_JSON_PATH, () => connector.capability())

      .post("/discovery", async ({ body, headers }) => {
        assertBearer(headers.authorization);
        const req = parseBody(DiscoveryRequest, body);
        return await withTimeout(req.timeoutMs, () => connector.discovery(req));
      })

      .post("/query", async ({ body, headers }) => {
        assertBearer(headers.authorization);
        const req = parseBody(NativeQueryRequest, body);
        return await withTimeout(req.timeoutMs, async () => ({
          rows: await connector.query(req),
        }));
      })

      .post("/count", async ({ body, headers }) => {
        assertBearer(headers.authorization);
        const req = parseBody(CountRequest, body);
        return await withTimeout(req.timeoutMs, async () => ({
          count: await connector.count(req),
        }));
      })

      .post("/query/stream", ({ body, headers }) => {
        assertBearer(headers.authorization);
        const req = parseBody(NativeQueryStreamRequest, body);
        // the stream owns its idle/hard deadlines; no outer withTimeout
        return ndjsonStream(connector.queryStream(req), {
          idleTimeoutMs: req.idleTimeoutMs,
          maxTimeoutMs: req.maxTimeoutMs,
        });
      })

      .post("/aggregate", async ({ body, headers, set }) => {
        assertBearer(headers.authorization);
        const req = parseBody(AggregateRequest, body);
        return await withTimeout(req.timeoutMs, async () => {
          const rows = await connector.aggregate(req);
          // 204 declines this aggregate to the caller; a wrong number is never legal
          if (rows === undefined) {
            set.status = 204;
            return undefined;
          }
          return { rows };
        });
      })

      .post("/probe/columns", async ({ body, headers }) => {
        assertBearer(headers.authorization);
        const req = parseBody(ProbeColumnsRequest, body);
        // a JSON null body is the wire-legal "no probe"; wrapped so Elysia never sends an empty 200
        const probe = await withTimeout(req.timeoutMs, () => connector.probeColumns(req));
        return Response.json(probe);
      })

      .post("/probe/link", async ({ body, headers }) => {
        assertBearer(headers.authorization);
        const req = parseBody(ProbeLinkRequest, body);
        const probe = await withTimeout(req.timeoutMs, () => connector.probeLink(req));
        return Response.json(probe);
      })

      .post("/probe/grain", async ({ body, headers }) => {
        assertBearer(headers.authorization);
        const req = parseBody(ProbeGrainRequest, body);
        const probe = await withTimeout(req.timeoutMs, () => connector.probeGrain(req));
        return Response.json(probe);
      })

      .post("/count/exact", async ({ body, headers }) => {
        assertBearer(headers.authorization);
        const req = parseBody(CountExactRequest, body);
        // null count sits inside the wrapper, never a bare null body
        return await withTimeout(req.timeoutMs, async () => ({
          count: await connector.countExact(req),
        }));
      })

      .post("/sample/keyValues", async ({ body, headers }) => {
        assertBearer(headers.authorization);
        const req = parseBody(SampleKeyValuesRequest, body);
        return await withTimeout(req.timeoutMs, async () => ({
          values: await connector.sampleKeyValues(req),
        }));
      })
  );
}
