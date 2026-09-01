# examples

two reference connectors built on `@futurity/atlas-connector`, one per path. both are
multi-tenant the same way: the credentials arrive on every request, so one running process
serves any number of databases or bases and stores none of them.

- **[brightline-crm](./brightline-crm)**: a SQL source. `extends SqlConnector`: you provide a `catalog`, `openPool`/`closePool` from the tenant's `databaseUrl`, and one `run(pool, sql, params)`, and the base class serves every protocol method. this is the shortest way to make a postgres/mysql/etc. dataset queryable by atlas.

- **[lark](./lark)**: a REST/API source (lark base / bitable). `extends AtlasConnector`: `check`, `query`, `count`, and `discover` are hand-written, pushing lark's server-side filter for what it supports and running the residual through the kit's `applyFilters`; the profiling methods are left to the base class, which scans through `query()`. this is the shape any REST or ERP business system takes, and it shows the real decision: what pushes down to the api vs what runs in memory.

both consume the SDK from the repo root via a `file:../..` link; a standalone connector installs it from npm (`bun add @futurity/atlas-connector`). see the root README and the futurity docs for the design walkthrough.
