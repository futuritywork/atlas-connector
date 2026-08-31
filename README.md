# @futurity/atlas-connector

Build a [Futurity](https://futurity.work) Atlas **external connector**: a
standalone HTTP service that answers Atlas's queries against your database or
API. The SDK owns the wire protocol (Zod schemas), the server runtime (auth,
timeouts, NDJSON streaming, error envelope), and a full SQL query engine — you
write only the part that talks to your source.

```sh
bun create atlas-connector my-connector
```

The scaffolder asks what backs your source and stamps the matching starter:

- **sql** — a SQL database. Extend `SqlConnector`: declare a catalog, write one
  `run(sql, params)`. Everything else is derived. (~45 lines for postgres.)
- **rest** — a REST/ERP API (Anaplan, Workday, Dynamics, ...). Extend
  `AtlasConnector`: ten methods, five mandatory, each marked `YOUR CODE HERE`
  with its return contract.

Scriptable: `bun create atlas-connector my-crm --kind sql --port 4100`.

## Quickstart: a SQL database

Three files, the whole connector:

```ts
// src/catalog.ts — declare your tables
import { col, defineCatalog } from "@futurity/atlas-connector/sql";

export const catalog = defineCatalog([
  {
    name: "companies",
    description: "Accounts.",
    primaryKey: ["id"],
    foreignKeys: [],
    columns: [
      col("id", "int", "number", { unique: true }),
      col("name", "text", "string"),
      col("created_at", "datetime", "datetime"),
    ],
  },
]);
```

```ts
// src/connector.ts — one method: run a parameterized statement
import { postgres, SqlConnector, type Row } from "@futurity/atlas-connector/sql";
import { sql } from "bun";
import { catalog } from "./catalog";

export class MyConnector extends SqlConnector {
  readonly slug = "my-crm";
  readonly catalog = catalog;
  readonly schema = "public";
  readonly flavor = postgres();

  async run(text: string, params: unknown[]): Promise<Row[]> {
    return await sql.unsafe(text, params as never[]);
  }
}
```

```ts
// src/index.ts
import { serve } from "@futurity/atlas-connector";
import { MyConnector } from "./connector";

serve(new MyConnector(), { token: process.env.ATLAS_CONNECTOR_TOKEN!, port: 4100 });
```

`SqlConnector` implements all ten protocol methods over `run()`: discovery,
queries, streaming, counts, probes, and GROUP BY pushdown. The capability doc
is **derived from the catalog and flavor**, so the connector can never
advertise an operator its builders won't render.

## Quickstart: a REST / ERP API

Extend `AtlasConnector` and write the five mandatory methods; the five
optionals default to a wire-legal "not implemented":

| method              | you return                                                     |
| ------------------- | -------------------------------------------------------------- |
| `discovery(req)`    | your API's entities as `{ tables, warnings? }`                 |
| `query(req)`        | rows: push what the API can filter, `applyFilters()` the rest  |
| `queryStream(req)`  | the same rows as batches (≤5000 rows each)                     |
| `count(req)`        | how many rows match the filters                                |
| `sampleKeyValues(req)` | sorted distinct head of a column, as text                   |

`serve()` owns bearer auth, body parsing, timeouts, heartbeats, and the error
envelope — your methods receive the parsed request and return plain data. The
kit meets you halfway: `applyFilters` evaluates residual filters in memory with
exactly the SQL engine's semantics, and `columnCountsFromValues` /
`linkFromValues` / `grainFromValues` turn fetched values into probe answers.

A REST connector authors its own `capability.ts` — the honesty contract. Only
you know which ops your pushdown + `applyFilters` combination honors; every
flag is earned, and the starter begins narrow.

## The protocol

A connector serves one unauthenticated GET —
`/.well-known/futurity/atlas.json`, the capability doc — and ten bearer-guarded
POST endpoints (`/discovery`, `/query`, `/query/stream`, `/count`,
`/count/exact`, `/aggregate`, `/probe/columns`, `/probe/link`, `/probe/grain`,
`/sample/keyValues`). The wire contract is defined, executably, by the Zod
schemas in [`src/wire/schemas.ts`](src/wire/schemas.ts) (requests, answers,
stream lines) and [`src/wire/atlas-json.ts`](src/wire/atlas-json.ts) (the
capability doc). [`example/`](example) is a complete reference connector — a
seeded five-table CRM. Before registering a connector with Atlas, grade it with
the `atlas-conform` conformance runner.

## API reference

### `@futurity/atlas-connector`

**Vocabulary** (`ATLAS_TYPES`/`AtlasType`, `AtlasValue`, `OPS`/`Op`, `Filter`,
`UserSort`, `JoinField`, `DATE_GRAINS`/`DateGrain`, `SourceRow`) — the shared
protocol types. `SourceRow` is the wire-legal row a connector returns:
`Record<string, string | number | boolean | null>`.

**Wire schemas** — every request (`DiscoveryRequest`, `NativeQueryRequest`,
`NativeQueryStreamRequest`, `CountRequest`, `CountExactRequest`,
`AggregateRequest`, `ProbeColumnsRequest`, `ProbeLinkRequest`,
`ProbeGrainRequest`, `SampleKeyValuesRequest`, dialect-mode duals), every
answer (`QueryAnswer`, `CountAnswer`, `DiscoveryAnswer`, ...), `StreamLine`,
`WireError`, and the probe/discovery result types (`DiscoveredTable`,
`TableColumnsProbe`, `LinkProbe`, `GrainProbe`, ...). `CONNECTOR_LIMITS` holds
the protocol's size and heartbeat bounds. `AtlasJson`,
`SourceCapabilitiesWire`, `ATLAS_JSON_PATH` describe the capability doc.

**`AtlasConnector`** — the class to inherit. Five abstract methods
(`discovery`, `query`, `queryStream`, `count`, `sampleKeyValues`) and five
optional ones with wire-legal defaults (`countExact`, `probeColumns`,
`probeLink`, `probeGrain` answer `null`; `aggregate` declines with 204).

**`serve(connector, { token, port?, hostname? })`** — boots the HTTP server;
returns `{ app, url, stop }`. Boot-fails on a token under 32 chars or an
invalid capability doc, and warns when advertised endpoints and overridden
methods disagree. `createApp(connector, { token })` returns the Elysia app for
tests and embedding.

**Errors and http** — `ConnectorError` plus the constructors `badRequest`,
`unauthorized`, `unknownEntity`, `unsupported`, `timeout`; `parseBody`
(400 envelope, never 422), `withTimeout` (408 on expiry), `bearerGuard`
(timing-safe compare), `ndjsonStream` (heartbeats, `{rows}`/`{ping}`/
`{error}`/`{end:1}` framing).

**Kit** — `applyFilters(rows, { and, or? }, fieldTypes?)` evaluates filters in memory with the
SQL engine's exact semantics (`nin` keeps nulls, empty `in` matches nothing,
...). `columnCountsFromValues`, `linkFromValues`, `grainFromValues` compute
probe answers from fetched values; `NEAR_UNIQUE_MIN_SHARE`, `DUP_SAMPLE_CAP`,
`ORPHAN_SAMPLE_CAP` are the protocol's tuning constants.

### `@futurity/atlas-connector/sql`

**`SqlConnector`** — implements all ten protocol methods from an abstract
`run(sql, params)` plus a `catalog`, `schema`, and `flavor`. Optional
`streamBatches` override for drivers with real cursors;
`enforcesDeclaredKeys = true` only when every declared key is a real db
constraint. `capability()` derives the doc; override to narrow.

**Catalog** — `defineCatalog(tables)`, `col(name, wire, type, opts?)`, and the
`Catalog`/`Table`/`Column`/`CatalogForeignKey`/`WireKind` types.

**`SqlFlavor`** — the dialect seam (placeholders, ident quoting, date
rendering, collation pins). v1 ships `postgres()`; other dialects land here.

**Builders** — `buildSelect`, `buildCount`, `buildAggregate`, `buildWhere`,
`renderRows`, `renderAggregateRows`, `projectExpression`, `renderValue`,
`Binder`, plus the probe/discovery SQL and `sqlCapability`. Protocol law
(null ordering, empty-`in`, LIKE escaping, 2^53 fencing, decline-vs-wrong-
answer for aggregates) is hardcoded; only spellings go through the flavor.

## License

MIT
