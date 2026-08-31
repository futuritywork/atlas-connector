# examples

two reference connectors built on `@futurity/atlas-connector`, one per path.

- **[brightline-crm](./brightline-crm)** — a SQL source. `extends SqlConnector`: you provide a `catalog` and a `run(sql, params)` and the base class serves every protocol method. the whole connector is ~55 lines. this is the shortest way to make a postgres/mysql/etc. dataset queryable by atlas.

- **[lark](./lark)** — a REST/API source (lark base / bitable). `extends AtlasConnector`: the ten methods are hand-written, pushing lark's server-side filter for what it supports and running the residual through the kit's `applyFilters`, with probes via the kit's probe-math. this is the shape any REST or ERP business system takes, and it shows the real decision — what pushes down to the api vs runs in memory.

both consume the SDK from the repo root via a `file:../..` link; a standalone connector installs it from npm (`bun add @futurity/atlas-connector`). see the root README and the futurity docs for the design walkthrough.
