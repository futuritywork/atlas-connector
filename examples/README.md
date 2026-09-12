# examples

four reference connectors built on `@futurity/atlas-connector`, across the SQL and
REST/ERP paths. all are multi-tenant the same way: the credentials arrive on every
request, so one running process serves any number of databases, bases, or source
accounts and stores none of them.

- **[brightline-crm](./brightline-crm)**: a SQL source. `extends SqlConnector`:
  provide a `catalog`, tenant-scoped `openPool`/`closePool`, and one
  `run(pool, sql, params)`; the base class serves every protocol method. this is
  the shortest way to make a Postgres/MySQL-style dataset queryable by atlas.

- **[lark](./lark)**: a REST/API source (Lark Base / Bitable). `extends
  AtlasConnector`: `check`, `query`, and `discovery` are hand-written, and
  `pushdown.ts` declares per field type which ops go upstream and whether lark's
  answer is atlas's answer or a wider set the host trims; the capability doc's
  `operators` are emitted from it. filter, or-groups and sort ride on
  `records/search`, an eq on `record_id` is a single `GET records/{record_id}`,
  `size()` and `count()` come from a search page's `total`, and the same plan is
  yielded as the stream's leading `{ served }` line. it demonstrates the general
  REST connector shape.

- **[stamps](./stamps)**: a read-only REST connector for Stamps API v4. it exposes
  stores and cursor-paginated rewards, validates every upstream response, and
  accepts each tenant's merchant token per request. the v4 api filters nothing and
  sorts nothing, so its pushdown map is empty and atlas narrows the two small
  tables itself; `size()` answers for `stores` from the one index request and
  `null` for the cursor-paged `rewards`.

- **[esb](./esb)**: a complete REST/ERP connector for ESB Core 2.0. it carries a
  curated 39-entity catalog, strict authentication and response validation,
  partial discovery warnings, full residual filtering, digit-exact sorting,
  paging, and a process-local token coordinator. ESB credentials remain
  request-scoped; the documented deployment is intentionally one replica.

all consume the SDK from the repo root via a `file:../..` link. `bunfig.toml`
selects Bun's hoisted linker so the shared host and the examples load the same SDK
instance. keep this setting when deploying the shared host: `createApp` decides
which optional routes to mount from the connector instance, and `ConnectorError`
is recognized across sdk copies by shape, but one shared class identity keeps
both cheap. when switching an existing checkout from isolated installs, remove the
generated `node_modules` directories at the root and under `cli` and `examples/*`,
then run `bun install --frozen-lockfile`. Bun can otherwise retain the nested links
from the isolated install.

a standalone connector installs the SDK from npm
(`bun add @futurity/atlas-connector`). see the root README and the futurity docs
for the design walkthrough.

## the hosted demo

CI runs `bun run scripts/smoke-examples.ts` after seeding Brightline. the script
checks the SQL example and discovers hosted connectors from the root manifest,
so registering a connector in `examples/index.ts` includes it in the smoke check.
it requires `ATLAS_CONNECTOR_TOKEN` and the seeded `CONNECTOR_DATABASE_URL`.
entrypoints report their OS-assigned listening URL over Bun IPC; the script
bounds each subprocess to 30 seconds and stops it when finished.

`bun run start` at the repo root runs `examples/index.ts`: one process, each
connector mounted at `/<slug>` on one origin, one `ATLAS_CONNECTOR_TOKEN` for the
host. a source registers with the prefix as its base url, e.g.
`https://<host>/lark-base`, `https://<host>/esb-core`, or `https://<host>/stamps`;
the capability doc is at `<base>/.well-known/futurity/atlas.json`. lark, esb-core,
and stamps are in it: brightline opens a pool to whatever `databaseUrl` a caller
sends, so it stays off any public host. esb-core is process-local by design, so
run the demo host as a single replica.
