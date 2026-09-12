import { type QueryChunk, SERVED_NOTHING } from "../connector";
import { CONNECTOR_LIMITS } from "../wire/limits";
import type { NativeQueryRequest, Served, StreamLine } from "../wire/schemas";
import { ConnectorError } from "./errors";

const ENCODER = new TextEncoder();

// a connector error keeps its code; anything else is opaque on the wire, real in the log
function errorLine(cause: unknown): StreamLine {
  const connectorError = ConnectorError.fromCause(cause);
  if (connectorError) return { error: connectorError.body().error };
  const causeName = cause instanceof Error ? cause.name : "";
  const cutByOwnDeadline = causeName === "TimeoutError" || causeName === "AbortError";
  if (cutByOwnDeadline) {
    return { error: { code: "timeout", message: "the upstream request passed its deadline" } };
  }
  console.error("[connector] query stream failed", cause);
  return { error: { code: "internal", message: "internal error" } };
}

// a window is the answer only when the filter and the order behind it are served too
function clampServed(served: Served, request: Pick<NativeQueryRequest, "sort"> | undefined): Served {
  const sort = served.sort || request?.sort.length === 0; // no order asked for is already in order
  return { filters: served.filters, sort, window: served.window && served.filters && sort };
}

/** frames a producer's chunks as the wire's ndjson; a terminal {error} replaces the {end:1}. */
export function ndjsonStream(
  chunks: AsyncIterable<QueryChunk>,
  deadlines: { idleTimeoutMs: number; maxTimeoutMs: number },
  request?: Pick<NativeQueryRequest, "sort">,
): Response {
  const iterator = chunks[Symbol.asyncIterator]();
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastRowsAt = Date.now();
      const write = (line: StreamLine) => {
        if (!closed) controller.enqueue(ENCODER.encode(`${JSON.stringify(line)}\n`));
      };

      let headWritten = false;
      const writeHead = (served: Served) => {
        if (headWritten) return;
        headWritten = true;
        write({ served: clampServed(served, request) });
      };

      // proves life not progress; fires only when no batch went out in the window
      const heartbeat = setInterval(() => {
        if (Date.now() - lastRowsAt >= CONNECTOR_LIMITS.heartbeatIntervalMs) write({ ping: 1 });
      }, CONNECTOR_LIMITS.heartbeatIntervalMs);

      const hardDeadline = Date.now() + deadlines.maxTimeoutMs;
      // a deadline abandons a still-pending next(); awaiting return() then could hang the close
      let abandoned = false;

      try {
        for (;;) {
          if (closed) {
            abandoned = true;
            break;
          }
          if (Date.now() >= hardDeadline) {
            write({ error: { code: "timeout", message: "max stream duration exceeded" } });
            abandoned = true;
            break;
          }

          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          const idle = new Promise<"idle">((resolve) => {
            idleTimer = setTimeout(() => resolve("idle"), deadlines.idleTimeoutMs);
          });
          const outcome = await Promise.race([iterator.next(), idle]).finally(() => clearTimeout(idleTimer));

          if (outcome === "idle") {
            write({ error: { code: "timeout", message: "no rows within idle deadline" } });
            abandoned = true;
            break;
          }
          if (outcome.done) {
            writeHead(SERVED_NOTHING);
            write({ end: 1 });
            break;
          }

          const chunk = outcome.value;
          const isPlan = !Array.isArray(chunk);
          if (isPlan) {
            writeHead(chunk.served);
            continue;
          }
          writeHead(SERVED_NOTHING);
          if (chunk.length === 0) continue;

          // the wire caps a line at rowsPerBatch rows
          for (let i = 0; i < chunk.length; i += CONNECTOR_LIMITS.rowsPerBatch) {
            write({ rows: chunk.slice(i, i + CONNECTOR_LIMITS.rowsPerBatch) });
          }
          lastRowsAt = Date.now();
        }
      } catch (error) {
        write(errorLine(error));
      } finally {
        clearInterval(heartbeat);
        // let the producer's finally run (cursors, connections); not awaited when abandoned
        const settled = iterator.return?.().catch(() => {});
        if (settled && !abandoned) await settled;
        closed = true;
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      closed = true;
      iterator.return?.()?.catch(() => {});
    },
  });

  return new Response(body, {
    headers: { "content-type": "application/x-ndjson" },
  });
}
