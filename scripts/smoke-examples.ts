import assert from "node:assert/strict";
import { z } from "zod";
import {
  AtlasJson,
  CheckAnswer,
  type CheckRequest,
  type NativeQueryStreamRequest,
  StreamLine,
} from "../src/index";

const token = z.string().min(32).parse(process.env.ATLAS_CONNECTOR_TOKEN);
const databaseUrl = z.string().min(1).parse(process.env.CONNECTOR_DATABASE_URL);

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert(response.ok, `${url}: HTTP ${response.status}`);
  return response;
}

async function post(url: string, body: CheckRequest | NativeQueryStreamRequest): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

async function smoke(entry: string, verify: (base: string) => Promise<void>): Promise<void> {
  const ready = Promise.withResolvers<unknown>();
  const server = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, PORT: "0", CONNECTOR_PORT: "0" },
    stdout: "inherit",
    stderr: "inherit",
    timeout: 30_000,
    killSignal: "SIGKILL",
    ipc: ready.resolve,
    onExit: (_server, code) => ready.reject(new Error(`${entry} exited before readiness (${code})`)),
  });
  try {
    const base = z.url().parse(await ready.promise);
    await verify(base);
    console.log(`smoke passed: ${entry}`);
  } finally {
    server.kill("SIGKILL");
    await server.exited;
  }
}

await smoke("examples/brightline-crm/src/index.ts", async (base) => {
  const doc = AtlasJson.parse(await (await get(`${base}/.well-known/futurity/atlas.json`)).json());
  assert.equal(doc.slug, "brightline");
  assert(doc.credentialSchema.some((field) => field.key === "databaseUrl"));

  const credentials = { databaseUrl };
  const check = await post(`${base}/check`, { credentials, timeoutMs: 10_000 });
  assert.equal(check.status, 200);
  CheckAnswer.parse(await check.json());

  const query = await post(`${base}/query`, {
    table: "owners", and: [], sort: [], fields: ["id"], limit: 1, credentials,
    timeoutMs: 10_000, idleTimeoutMs: 10_000, maxTimeoutMs: 10_000,
  });
  assert.equal(query.status, 200);
  const framed = (await query.text()).trim().split("\n").map((line) => StreamLine.parse(JSON.parse(line)));
  assert.deepEqual(framed[0], { served: { filters: true, sort: true, window: true } });
  assert.deepEqual(framed.at(-1), { end: 1 });
  assert.equal(framed.filter((line) => "rows" in line).length, 1);
});

await smoke("examples/index.ts", async (base) => {
  const manifest = z.object({ connectors: z.array(z.string().regex(/^\/[a-z0-9-]+$/)).min(1) })
    .parse(await (await get(base)).json());
  for (const prefix of manifest.connectors) {
    const doc = AtlasJson.parse(await (await get(`${base}${prefix}/.well-known/futurity/atlas.json`)).json());
    assert.equal(`/${doc.slug}`, prefix);
    const denied = await fetch(`${base}${prefix}/check`, { method: "POST", signal: AbortSignal.timeout(5_000) });
    assert.equal(denied.status, 401);
  }

  // an unknown table is a terminal {error} line, not a status
  const response = await post(`${base}/stamps/query`, {
    table: "missing", and: [], sort: [], fields: [], credentials: { merchantToken: "unused" },
    timeoutMs: 1_000, idleTimeoutMs: 1_000, maxTimeoutMs: 1_000,
  });
  assert.equal(response.status, 200);
  const lines = (await response.text()).trim().split("\n").map((line) => StreamLine.parse(JSON.parse(line)));
  assert.deepEqual(lines.at(-1), { error: { code: "unknown_entity", message: 'unknown table "missing"' } });
});
