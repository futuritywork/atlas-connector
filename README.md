# @futurity/atlas-connector

Build a [Futurity](https://futurity.work) Atlas **external connector**: a
standalone HTTP service that answers Atlas's queries against your database or
API. The SDK owns the wire protocol (Zod schemas), the server runtime (auth,
timeouts, NDJSON streaming, error envelope), and a full SQL query engine; you
write only the part that talks to your source.

```sh
bun create atlas-connector my-connector
```

The scaffolder asks what backs your source and stamps the matching starter:

- **sql**: a SQL database. Extend `SqlConnector`: declare a catalog, open a
  pool, write one `run(pool, sql, params)`. Everything else is derived.
- **rest**: a REST/ERP API (Anaplan, Workday, Dynamics, ...). Extend
  `AtlasConnector`: four methods to write, the rest derived, each marked
  `YOUR CODE HERE` with its contract.

Scriptable: `bun create atlas-connector my-crm --kind sql --port 4100`.

## Tenancy

You host one connector; every client connects to it with their own credentials.
The capability doc declares a `credentialSchema`, the exact inputs Atlas shows
the person connecting, and each authenticated request carries those values back
as `credentials`, which is the only place your code reads them from. A field is
`text`, `password` (masked) or `textarea` (a multi-line box for a pasted key),
and `required: false` marks one a tenant may leave blank, which then arrives
with the key absent. Give every field a `placeholder` and a `help` string:
`help` is short markdown rendered between the label and the input, and it
should name the exact page in the vendor's console the value is copied from and
link the vendor's doc for it. Nothing upstream is configured in the connector's
environment and nothing is persisted between requests, so one deployment serves
any number of tenants, an added tenant is a form someone fills in, and a leaked
connector process holds no customer secret to leak.

## Quickstart: a SQL database

Three files, the whole connector:

```ts
// src/catalog.ts: declare your tables
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
// src/connector.ts: a pool per tenant, and one way to run a statement
import { SQL } from "bun";
import type { Credentials } from "@futurity/atlas-connector";
import { postgres, SqlConnector, type Row } from "@futurity/atlas-connector/sql";
import { catalog } from "./catalog";

export class MyConnector extends SqlConnector<SQL> {
  readonly slug = "my-crm";
  readonly catalog = catalog;
  readonly schema = "public";
  override readonly flavor = postgres();

  protected override async openPool(credentials: Credentials): Promise<SQL> {
    return new SQL(credentials.databaseUrl);
  }

  protected override async closePool(pool: SQL): Promise<void> {
    await pool.close();
  }

  async run(pool: SQL, sql: string, params: unknown[]): Promise<Row[]> {
    return (await pool.unsafe(sql, params)) as Row[];
  }
}
```

```ts
// src/index.ts: boot it
import { serve } from "@futurity/atlas-connector";
import { MyConnector } from "./connector";

serve(new MyConnector(), { token: process.env.ATLAS_CONNECTOR_TOKEN ?? "", port: 4100 });
```

There is nothing to obtain for `ATLAS_CONNECTOR_TOKEN`: you mint it (`openssl rand -hex 24`), set it on the connector, and paste the same value into the Token field when registering the source in Atlas.

`SqlConnector` implements every protocol method over `run()`: `check`
(`SELECT 1`), discovery, queries, streaming, counts, profiling, and GROUP BY
pushdown. Pools are cached per credential set, and an evicted pool closes only
once the last request holding it is done. The capability doc, including
the default `databaseUrl` credential, is **derived from the catalog and
flavor**, so the connector can never advertise an operator its builders won't
render.

## Quickstart: a REST / ERP API

Extend `AtlasConnector`. Four methods carry everything the source alone knows:

| method          | you return                                                                         |
| --------------- | ---------------------------------------------------------------------------------- |
| `check(req)`    | nothing; throw if `req.credentials` are wrong, and the tenant reads it              |
| `query(req)`    | batches of rows (≤5000 each): push what the API filters, `applyFilters()` the rest  |
| `count(req)`    | how many rows match the filters                                                     |
| `discover(req)` | the API's entities as `{ tables, warnings? }`                                       |

The profiling five (`profileColumns`, `profileLink`, `profileGrain`,
`exactCount`, `sampleColumnValues`) scan through your `query()` on the base
class and are correct by default; override one only to make it cheaper.
`aggregate()` declines with a 204 until you implement it.

`serve()` owns bearer auth, body parsing, timeouts, heartbeats, and the error
envelope. The kit meets you halfway: `applyFilters` evaluates residual filters
in memory with exactly the SQL engine's semantics, `assertKnownFields` turns a
filter you cannot answer into a 422 (rows that skipped a filter read as rows
that matched it), and `columnCountsFromValues` / `linkFromValues` /
`grainFromValues` turn fetched values into probe answers.

A REST connector authors its own capability document alongside the connector;
the starter keeps it in `capability.ts`. Only you know which operators your
pushdown and `applyFilters` combination honors, and only you know which
credentials your API needs; every flag is earned, and the starter begins narrow.

## The protocol

A connector serves one unauthenticated GET,
`/.well-known/futurity/atlas.json` (the capability doc), plus eleven
bearer-guarded POST endpoints (`/check`, `/discovery`, `/query`,
`/query/stream`, `/count`, `/count/exact`, `/aggregate`, `/probe/columns`,
`/probe/link`, `/probe/grain`, `/sample/keyValues`). Every POST body carries
`credentials` and `timeoutMs`. The wire contract is defined, executably, by the
Zod schemas in [`src/wire/schemas.ts`](src/wire/schemas.ts) (requests, answers,
stream lines) and [`src/wire/atlas-json.ts`](src/wire/atlas-json.ts) (the
capability doc). [`examples/`](examples) holds three complete connectors across
the SQL and REST paths. Before registering a connector with Atlas, grade it
with the `atlas-conform` conformance runner.

## API reference

### `@futurity/atlas-connector`

**Vocabulary** (`ATLAS_TYPES`/`AtlasType`, `AtlasValue`, `OPS`/`Op`, `Filter`,
`UserSort`, `JoinField`, `DATE_GRAINS`/`DateGrain`, `SourceRow`): the shared
protocol types. `SourceRow` is the wire-legal row a connector returns:
`Record<string, string | number | boolean | null>`.

**Wire schemas**: every request (`CheckRequest`, `DiscoveryRequest`,
`NativeQueryRequest`, `NativeQueryStreamRequest`, `CountRequest`,
`CountExactRequest`, `AggregateRequest`, `ProbeColumnsRequest`,
`ProbeLinkRequest`, `ProbeGrainRequest`, `SampleKeyValuesRequest`, dialect-mode
duals), `Credentials`, every answer (`QueryAnswer`, `CountAnswer`,
`DiscoveryAnswer`, ...), `StreamLine`, `WireError`, and the probe/discovery
result types (`DiscoveredTable`, `TableColumnsProbe`, `LinkProbe`,
`GrainProbe`, ...). `CONNECTOR_LIMITS` holds the protocol's size and heartbeat
bounds. `AtlasJson`, `SourceCapabilitiesWire`, `CredentialField`,
`ATLAS_JSON_PATH` describe the capability doc.

**`AtlasConnector`**: the class to inherit, in four planes: identity (`slug`,
`capability`, `check`), query (`query`, `count`, `aggregate`), discovery
(`discover`), and profiling (`profileColumns`, `profileLink`, `profileGrain`,
`exactCount`, `sampleColumnValues`, all derived from `query`).

**`serve(connector, { token, port?, hostname? })`**: boots the HTTP server;
returns `{ app, url, stop }`. Boot-fails on a token under 32 chars or an
invalid capability doc. `createApp(connector, { token })` returns the Elysia
app for tests and embedding.

**Errors and http**: `ConnectorError` plus the constructors `badRequest`,
`unauthorized`, `unknownEntity`, `unsupported`, `timeout`; `parseBody`
(400 envelope, never 422), `withTimeout` (408 on expiry), `bearerGuard`
(timing-safe compare), `ndjsonStream` (heartbeats, `{rows}`/`{ping}`/
`{error}`/`{end:1}` framing).

**Kit**: `applyFilters(rows, { and, or? }, fieldTypes?)` evaluates filters in
memory with the SQL engine's exact semantics (`nin` keeps nulls, empty `in`
matches nothing, ...). `assertKnownFields(req, fields)` raises the 422.
`columnCountsFromValues`, `linkFromValues`, `grainFromValues`,
`sampleFromValues` compute probe answers from fetched values;
`NEAR_UNIQUE_MIN_SHARE`, `DUP_SAMPLE_CAP`, `ORPHAN_SAMPLE_CAP` are the
protocol's tuning constants.

### `@futurity/atlas-connector/sql`

**`SqlConnector<Pool>`**: implements every protocol method from
`openPool(credentials)` / `run(pool, sql, params)` / `closePool(pool)` plus a
`catalog`, `schema`, and `flavor`. Pools are cached per credential set (LRU,
16 tenants) and an evicted pool closes only after the last request holding it
returns. Optional `streamBatches` override for drivers with real cursors;
`enforcesDeclaredKeys = true` only when every declared key is a real db
constraint. `capability()` derives the doc; override `credentialSchema` when
the driver takes separate parts instead of one url, keeping a `placeholder` and
a `help` string on each part.

**Catalog**: `defineCatalog(tables)`, `col(name, wire, type, opts?)`, and the
`Catalog`/`Table`/`Column`/`CatalogForeignKey`/`WireKind` types.

**`SqlFlavor`**: the dialect seam (placeholders, ident quoting, date
rendering, collation pins). v1 ships `postgres()`; other dialects land here.

**Builders**: `buildSelect`, `buildCount`, `buildAggregate`, `buildWhere`,
`renderRows`, `renderAggregateRows`, `projectExpression`, `renderValue`,
`Binder`, plus the probe/discovery SQL and `sqlCapability`. Protocol law
(null ordering, empty-`in`, LIKE escaping, 2^53 fencing, decline-vs-wrong-
answer for aggregates) is hardcoded; only spellings go through the flavor.

## License

MIT
