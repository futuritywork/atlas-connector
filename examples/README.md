# examples

four reference connectors built on `@futurity/atlas-connector`, across the SQL and
REST/ERP paths. all are multi-tenant the same way: the credentials arrive on every
request, so one running process serves any number of databases, bases, or source
accounts and stores none of them.

- **[brightline-crm](./brightline-crm)**: a SQL source. `extends SqlConnector`:
  provide a `catalog`, tenant-scoped `openPool`/`closePool`, and one
  `run(pool, sql, params)`; the base class serves every protocol method. This is
  the shortest way to make a Postgres/MySQL-style dataset queryable by Atlas.

- **[lark](./lark)**: a REST/API source (Lark Base / Bitable). `extends
  AtlasConnector`: `check`, `query`, `count`, and `discover` are hand-written,
  pushing the server-side filter slice and running the residual through
  `applyFilters`. It demonstrates the general REST connector shape.

- **[stamps](./stamps)**: a read-only REST connector for Stamps API v4. it exposes stores and cursor-paginated rewards, validates every upstream response, applies the full Atlas filter vocabulary locally, and accepts each tenant's merchant token per request.

- **[esb](./esb)**: a complete REST/ERP connector for ESB Core 2.0. It carries a
  curated 39-entity catalog, strict authentication and response validation,
  partial discovery warnings, full residual filtering, digit-exact sorting,
  paging, scan counts, and a process-local token coordinator. ESB credentials
  remain request-scoped; the documented deployment is intentionally one
  replica.

all consume the SDK from the repo root via a `file:../..` link. `bunfig.toml`
selects Bun's hoisted linker so the shared host and the examples load the same SDK
instance. Keep this setting when deploying the shared host: its typed errors and
inherited-method checks rely on shared class identity. When switching an existing
checkout from isolated installs, remove the generated `node_modules` directories
at the root and under `cli` and `examples/*`, then run `bun install --frozen-lockfile`.
Bun can otherwise retain the nested links from the isolated install.

A standalone connector installs the SDK from npm (`bun add @futurity/atlas-connector`).
see the root README and the futurity docs for the design walkthrough.

## the hosted demo

CI runs `bun run scripts/smoke-examples.ts` after seeding Brightline. The script
checks the SQL example and discovers hosted connectors from the root manifest,
so registering a connector in `examples/index.ts` includes it in the smoke check.
It requires `ATLAS_CONNECTOR_TOKEN` and the seeded `CONNECTOR_DATABASE_URL`,
uses local ports 4100/4101, and stops the servers when finished.

`bun run start` at the repo root runs `examples/index.ts`: one process, each connector mounted at `/<slug>` on one origin, one `ATLAS_CONNECTOR_TOKEN` for the host. a source registers with the prefix as its base url, e.g. `https://<host>/lark-base`, `https://<host>/esb-core`, or `https://<host>/stamps`; the capability doc is at `<base>/.well-known/futurity/atlas.json`. lark, esb-core, and stamps are in it: brightline opens a pool to whatever `databaseUrl` a caller sends, so it stays off any public host. esb-core is process-local by design, so run the demo host as a single replica.
