import { describe, expect, test } from "bun:test";
import { CONNECTOR_LIMITS } from "../wire/limits";
import type { SourceRow } from "../wire/vocabulary";
import { unsupported } from "./errors";
import { ndjsonStream } from "./stream";

const RELAXED = { idleTimeoutMs: 1000, maxTimeoutMs: 5000 };

async function* fromBatches(batches: SourceRow[][]): AsyncIterable<SourceRow[]> {
  for (const batch of batches) yield batch;
}

async function readLines(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

describe("ndjsonStream", () => {
  test("frames batches as {rows} lines and terminates with {end:1}", async () => {
    const response = ndjsonStream(
      fromBatches([[{ a: 1 }], [{ a: 2 }, { a: 3 }]]),
      RELAXED,
    );
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = await readLines(response);
    expect(lines).toEqual([{ rows: [{ a: 1 }] }, { rows: [{ a: 2 }, { a: 3 }] }, { end: 1 }]);
  });

  test("an empty producer stream is just {end:1}", async () => {
    const lines = await readLines(ndjsonStream(fromBatches([]), RELAXED));
    expect(lines).toEqual([{ end: 1 }]);
  });

  test("empty batches are skipped (the wire forbids rows: [])", async () => {
    const lines = await readLines(ndjsonStream(fromBatches([[], [{ a: 1 }], []]), RELAXED));
    expect(lines).toEqual([{ rows: [{ a: 1 }] }, { end: 1 }]);
  });

  test("an oversized batch is re-chunked to rowsPerBatch lines", async () => {
    const big = Array.from({ length: CONNECTOR_LIMITS.rowsPerBatch + 1 }, (_, i) => ({ i }));
    const lines = await readLines(ndjsonStream(fromBatches([big]), RELAXED));
    expect(lines).toHaveLength(3);
    expect((lines[0] as { rows: unknown[] }).rows).toHaveLength(CONNECTOR_LIMITS.rowsPerBatch);
    expect((lines[1] as { rows: unknown[] }).rows).toHaveLength(1);
    expect(lines[2]).toEqual({ end: 1 });
  });

  test("a producer error is a terminal {error} with no end, first line only", async () => {
    async function* boom(): AsyncIterable<SourceRow[]> {
      yield [{ a: 1 }];
      throw new Error("secret driver detail\nstack frame");
    }
    const lines = await readLines(ndjsonStream(boom(), RELAXED));
    expect(lines).toEqual([
      { rows: [{ a: 1 }] },
      { error: { code: "internal", message: "secret driver detail" } },
    ]);
  });

  test("a ConnectorError crosses with its own wire code", async () => {
    async function* refuse(): AsyncIterable<SourceRow[]> {
      throw unsupported("no such op");
      yield [];
    }
    const lines = await readLines(ndjsonStream(refuse(), RELAXED));
    expect(lines).toEqual([{ error: { code: "unsupported", message: "no such op" } }]);
  });

  test("idle deadline: no batch in time is a terminal timeout error", async () => {
    async function* stalls(): AsyncIterable<SourceRow[]> {
      yield [{ a: 1 }];
      await new Promise(() => {});
    }
    const lines = await readLines(
      ndjsonStream(stalls(), { idleTimeoutMs: 30, maxTimeoutMs: 5000 }),
    );
    expect(lines).toEqual([
      { rows: [{ a: 1 }] },
      { error: { code: "timeout", message: "no rows within idle deadline" } },
    ]);
  });

  test("hard deadline: a live but endless producer is cut with a timeout error", async () => {
    async function* endless(): AsyncIterable<SourceRow[]> {
      for (;;) {
        await Bun.sleep(10);
        yield [{ a: 1 }];
      }
    }
    const lines = await readLines(
      ndjsonStream(endless(), { idleTimeoutMs: 1000, maxTimeoutMs: 60 }),
    );
    const last = lines.at(-1);
    expect(last).toEqual({ error: { code: "timeout", message: "max stream duration exceeded" } });
    expect(lines.some((line) => "end" in line)).toBe(false);
  });

  test("the producer's finally runs on clean completion", async () => {
    let released = false;
    async function* withCleanup(): AsyncIterable<SourceRow[]> {
      try {
        yield [{ a: 1 }];
      } finally {
        released = true;
      }
    }
    await readLines(ndjsonStream(withCleanup(), RELAXED));
    expect(released).toBe(true);
  });
});
