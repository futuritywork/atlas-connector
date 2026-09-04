import { CONNECTOR_LIMITS } from "../wire/limits";
import type { StreamLine } from "../wire/schemas";
import type { SourceRow } from "../wire/vocabulary";
import { isConnectorError } from "./errors";

// never leak a raw driver error onto the wire
function sanitize(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? "stream failed") : "stream failed";
}

// a ConnectorError crosses with its own wire code; anything else is an opaque internal
function errorLine(error: unknown): StreamLine {
  if (isConnectorError(error)) return { error: error.body().error };
  return { error: { code: "internal", message: sanitize(error) } };
}

// {end:1} is written only after the producer completes, so a truncated stream is distinguishable
// {error} is terminal with no end
export function ndjsonStream(
  batches: AsyncIterable<SourceRow[]>,
  deadlines: { idleTimeoutMs: number; maxTimeoutMs: number },
): Response {
  const encoder = new TextEncoder();
  const iterator = batches[Symbol.asyncIterator]();
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastRowsAt = Date.now();
      const write = (line: StreamLine) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      };

      // heartbeat proves life not progress; fires only when no batch went out in the window
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
            write({ end: 1 });
            break;
          }
          const batch = outcome.value;
          if (batch.length === 0) continue;
          // the wire caps a line at rowsPerBatch rows; an oversized producer batch is re-chunked
          for (let i = 0; i < batch.length; i += CONNECTOR_LIMITS.rowsPerBatch) {
            write({ rows: batch.slice(i, i + CONNECTOR_LIMITS.rowsPerBatch) });
          }
          lastRowsAt = Date.now();
        }
      } catch (error) {
        write(errorLine(error));
      } finally {
        clearInterval(heartbeat);
        // let the producer's finally blocks run (cursors, connections); off-response when abandoned
        const settle = iterator.return?.();
        if (settle !== undefined) {
          if (abandoned) settle.catch(() => {});
          else await settle.catch(() => {});
        }
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
