import { describe, expect, spyOn, test } from "bun:test";
import type { QueryChunk } from "../connector";
import { CONNECTOR_LIMITS } from "../wire/limits";
import type { SourceRow } from "../wire/vocabulary";
import { unsupported } from "./errors";
import { ndjsonStream } from "./stream";

const RELAXED = { idleTimeoutMs: 1000, maxTimeoutMs: 5000 };
const NOTHING = { served: { filters: false, sort: false, window: false } }; // the head when no plan is announced

async function* fromBatches(batches: SourceRow[][]): AsyncIterable<QueryChunk> {
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
    const response = ndjsonStream(fromBatches([[{ a: 1 }], [{ a: 2 }, { a: 3 }]]), RELAXED);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = await readLines(response);
    expect(lines).toEqual([NOTHING, { rows: [{ a: 1 }] }, { rows: [{ a: 2 }, { a: 3 }] }, { end: 1 }]);
  });

  test("an empty producer stream is just {end:1}", async () => {
    const lines = await readLines(ndjsonStream(fromBatches([]), RELAXED));
    expect(lines).toEqual([NOTHING, { end: 1 }]);
  });

  test("empty batches are skipped (the wire forbids rows: [])", async () => {
    const lines = await readLines(ndjsonStream(fromBatches([[], [{ a: 1 }], []]), RELAXED));
    expect(lines).toEqual([NOTHING, { rows: [{ a: 1 }] }, { end: 1 }]);
  });

  test("an oversized batch is re-chunked to rowsPerBatch lines", async () => {
    const big = Array.from({ length: CONNECTOR_LIMITS.rowsPerBatch + 1 }, (_, i) => ({ i }));
    const lines = await readLines(ndjsonStream(fromBatches([big]), RELAXED));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual(NOTHING);
    expect((lines[1] as { rows: unknown[] }).rows).toHaveLength(CONNECTOR_LIMITS.rowsPerBatch);
    expect((lines[2] as { rows: unknown[] }).rows).toHaveLength(1);
    expect(lines[3]).toEqual({ end: 1 });
  });

  test("a producer error is a terminal {error} with no end, opaque on the wire", async () => {
    async function* boom(): AsyncIterable<QueryChunk> {
      yield [{ a: 1 }];
      throw new Error("secret driver detail\nstack frame");
    }
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const lines = await readLines(ndjsonStream(boom(), RELAXED));
    expect(lines).toEqual([
      NOTHING,
      { rows: [{ a: 1 }] },
      { error: { code: "internal", message: "internal error" } },
    ]);
    expect(logged.mock.calls.length).toBe(1);
    logged.mockRestore();
  });

  test("an aborted upstream request crosses as a timeout, not an internal fault", async () => {
    async function* aborted(): AsyncIterable<QueryChunk> {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    const lines = await readLines(ndjsonStream(aborted(), RELAXED));
    expect(lines).toEqual([
      { error: { code: "timeout", message: "the upstream request passed its deadline" } },
    ]);
  });

  test("a ConnectorError crosses with its own wire code", async () => {
    async function* refuse(): AsyncIterable<QueryChunk> {
      throw unsupported("no such op");
    }
    const lines = await readLines(ndjsonStream(refuse(), RELAXED));
    expect(lines).toEqual([{ error: { code: "unsupported", message: "no such op" } }]);
  });

  test("idle deadline: no batch in time is a terminal timeout error", async () => {
    async function* stalls(): AsyncIterable<QueryChunk> {
      yield [{ a: 1 }];
      await new Promise(() => {});
    }
    const lines = await readLines(ndjsonStream(stalls(), { idleTimeoutMs: 30, maxTimeoutMs: 5000 }));
    expect(lines).toEqual([
      NOTHING,
      { rows: [{ a: 1 }] },
      { error: { code: "timeout", message: "no rows within idle deadline" } },
    ]);
  });

  test("a producer's plan is the stream's first line", async () => {
    async function* planned(): AsyncIterable<QueryChunk> {
      yield { served: { filters: true, sort: true, window: true } };
      yield [{ a: 1 }];
    }
    const lines = await readLines(ndjsonStream(planned(), RELAXED, { sort: [{ field: "a", dir: "asc" }] }));
    expect(lines).toEqual([
      { served: { filters: true, sort: true, window: true } },
      { rows: [{ a: 1 }] },
      { end: 1 },
    ]);
  });

  test("a request that asked for no order is trivially in order", async () => {
    async function* unsorted(): AsyncIterable<QueryChunk> {
      yield { served: { filters: true, sort: false, window: true } };
      yield [{ a: 1 }];
    }
    const lines = await readLines(ndjsonStream(unsorted(), RELAXED, { sort: [] }));
    expect(lines[0]).toEqual({ served: { filters: true, sort: true, window: true } });
  });

  test("a window claimed over an unserved filter or order is not a window", async () => {
    async function* overclaimed(): AsyncIterable<QueryChunk> {
      yield { served: { filters: false, sort: true, window: true } };
      yield [{ a: 1 }];
    }
    const lines = await readLines(ndjsonStream(overclaimed(), RELAXED, { sort: [{ field: "a", dir: "asc" }] }));
    expect(lines[0]).toEqual({ served: { filters: false, sort: true, window: false } });

    async function* unordered(): AsyncIterable<QueryChunk> {
      yield { served: { filters: true, sort: false, window: true } };
      yield [{ a: 1 }];
    }
    const later = await readLines(ndjsonStream(unordered(), RELAXED, { sort: [{ field: "a", dir: "asc" }] }));
    expect(later[0]).toEqual({ served: { filters: true, sort: false, window: false } });
  });

  test("a plan yielded after the first rows describes rows already read, so it is ignored", async () => {
    async function* late(): AsyncIterable<QueryChunk> {
      yield [{ a: 1 }];
      yield { served: { filters: true, sort: true, window: true } };
    }
    const lines = await readLines(ndjsonStream(late(), RELAXED, { sort: [{ field: "a", dir: "asc" }] }));
    expect(lines).toEqual([NOTHING, { rows: [{ a: 1 }] }, { end: 1 }]);
  });

  test("hard deadline: a live but endless producer is cut with a timeout error", async () => {
    async function* endless(): AsyncIterable<QueryChunk> {
      for (;;) {
        await Bun.sleep(10);
        yield [{ a: 1 }];
      }
    }
    const lines = await readLines(ndjsonStream(endless(), { idleTimeoutMs: 1000, maxTimeoutMs: 60 }));
    const last = lines.at(-1);
    expect(last).toEqual({ error: { code: "timeout", message: "max stream duration exceeded" } });
    expect(lines.some((line) => "end" in line)).toBe(false);
  });

  test("the producer's finally runs on clean completion", async () => {
    let released = false;
    async function* withCleanup(): AsyncIterable<QueryChunk> {
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
