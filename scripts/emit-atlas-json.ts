// emits the host's wire-agreement fixtures: one atlas.json per example connector, plus every ndjson line kind
// bun run scripts/emit-atlas-json.ts ../futurity-atlas-v4/packages/atlas/src/connector/fixtures

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ATLAS_JSON_PATH,
  type AtlasConnector,
  badRequest,
  CONNECTOR_LIMITS,
  createApp,
  type NativeQueryRequest,
  ndjsonStream,
  type QueryChunk,
} from "../src/index";

const TOKEN = "emit-atlas-json-fixture-token-0123456789";

// examples read their bearer from the environment at import, before any connector exists
process.env.ATLAS_CONNECTOR_TOKEN ??= TOKEN;

type SortedRequest = Pick<NativeQueryRequest, "sort">;

const SORTED: SortedRequest = { sort: [{ field: "id", dir: "asc" }] };

const STALL_MS = CONNECTOR_LIMITS.heartbeatIntervalMs + 1_000; // outlast one interval to earn a ping
const DEADLINES = { idleTimeoutMs: STALL_MS * 3, maxTimeoutMs: STALL_MS * 6 };

async function servedDoc(connector: AtlasConnector): Promise<unknown> {
  const app = createApp(connector, { token: TOKEN });
  const response = await app.handle(new Request(`http://fixture${ATLAS_JSON_PATH}`));
  if (!response.ok) throw new Error(`${connector.slug}: atlas.json returned HTTP ${response.status}`);
  return await response.json();
}

async function linesOf(chunks: AsyncIterable<QueryChunk>, request?: SortedRequest): Promise<string[]> {
  const text = await ndjsonStream(chunks, DEADLINES, request).text();
  return text.split("\n").filter((line) => line.length > 0);
}

async function* servedAllAndRows(): AsyncIterable<QueryChunk> {
  yield { served: { filters: true, sort: true, window: true } };
  yield [
    { id: "1", name: "a", amount: 1.5, active: true, closedAt: null },
    { id: "2", name: "b", amount: -2, active: false, closedAt: "2026-01-02T03:04:05.000Z" },
  ];
}

// an unserved filter or sort clamps the window away
async function* servedWindowOnly(): AsyncIterable<QueryChunk> {
  yield { served: { filters: false, sort: false, window: true } };
  yield [{ id: "3" }];
}

async function* stalls(): AsyncIterable<QueryChunk> {
  await new Promise((resolve) => setTimeout(resolve, STALL_MS));
  yield [{ id: "4" }];
}

async function* fails(): AsyncIterable<QueryChunk> {
  yield { served: { filters: true, sort: false, window: false } };
  throw badRequest("the upstream rejected the filter");
}

async function streamLines(): Promise<string[]> {
  return [
    ...(await linesOf(servedAllAndRows(), SORTED)),
    ...(await linesOf(servedWindowOnly(), SORTED)),
    ...(await linesOf(stalls())),
    ...(await linesOf(fails(), SORTED)),
  ];
}

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: bun run scripts/emit-atlas-json.ts <outDir>");
await mkdir(outDir, { recursive: true });

const { LarkConnector } = await import("../examples/lark/src/connector");
const { EsbCoreConnector } = await import("../examples/esb/src/connector");
const { StampsConnector } = await import("../examples/stamps/src/connector");
const { BrightlineConnector } = await import("../examples/brightline-crm/src/connector");

const connectors: Record<string, AtlasConnector> = {
  lark: new LarkConnector(),
  esb: new EsbCoreConnector(),
  stamps: new StampsConnector(),
  brightline: new BrightlineConnector(),
};

for (const [name, connector] of Object.entries(connectors)) {
  const path = join(outDir, `${name}.atlas.json`);
  await Bun.write(path, `${JSON.stringify(await servedDoc(connector), null, 2)}\n`);
  console.log(`wrote ${path}`);
}

const streamPath = join(outDir, "stream-lines.ndjson");
await Bun.write(streamPath, `${(await streamLines()).join("\n")}\n`);
console.log(`wrote ${streamPath}`);
