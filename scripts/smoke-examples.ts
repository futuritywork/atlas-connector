import assert from "node:assert/strict";
import { z } from "zod";
import { AtlasJson, CheckAnswer, QueryAnswer } from "../src/index";

const token = z.string().min(32).parse(process.env.ATLAS_CONNECTOR_TOKEN);
const databaseUrl = z.string().min(1).parse(process.env.CONNECTOR_DATABASE_URL);

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert(response.ok, `${url}: HTTP ${response.status}`);
  return response;
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

async function smoke(entry: string, port: number, readyPath: string, verify: (base: string) => Promise<void>) {
  const server = Bun.spawn([process.execPath, "run", entry], {
    env: { ...process.env, PORT: String(port), CONNECTOR_PORT: String(port) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const base = `http://localhost:${port}`;
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      assert(server.exitCode === null, `${entry} exited before readiness`);
      try {
        await get(`${base}${readyPath}`);
        break;
      } catch (cause) {
        if (Date.now() >= deadline) throw cause;
        await Bun.sleep(250);
      }
    }
    await verify(base);
    console.log(`smoke passed: ${entry}`);
  } finally {
    server.kill();
    await server.exited;
  }
}

await smoke("examples/brightline-crm/src/index.ts", 4100, "/.well-known/futurity/atlas.json", async (base) => {
  const doc = AtlasJson.parse(await (await get(`${base}/.well-known/futurity/atlas.json`)).json());
  assert.equal(doc.slug, "brightline");
  assert(doc.credentialSchema.some((field) => field.key === "databaseUrl"));
  const credentials = { databaseUrl };
  const check = await post(`${base}/check`, { credentials, timeoutMs: 10_000 });
  assert.equal(check.status, 200);
  CheckAnswer.parse(await check.json());
  const query = await post(`${base}/query`, {
    table: "owners", and: [], sort: [], fields: ["id"], limit: 1, credentials, timeoutMs: 10_000,
  });
  assert.equal(query.status, 200);
  assert.equal(QueryAnswer.parse(await query.json()).rows.length, 1);
});

await smoke("examples/index.ts", 4101, "/", async (base) => {
  const manifest = z.object({ connectors: z.array(z.string().regex(/^\/[a-z0-9-]+$/)).min(1) })
    .parse(await (await get(base)).json());
  for (const prefix of manifest.connectors) {
    const doc = AtlasJson.parse(await (await get(`${base}${prefix}/.well-known/futurity/atlas.json`)).json());
    assert.equal(`/${doc.slug}`, prefix);
    const denied = await fetch(`${base}${prefix}/check`, { method: "POST", signal: AbortSignal.timeout(5_000) });
    assert.equal(denied.status, 401);
  }
  const response = await post(`${base}/stamps/query`, {
    table: "missing", and: [], sort: [], fields: [], credentials: { merchantToken: "unused" }, timeoutMs: 1_000,
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "unknown_entity");
});
