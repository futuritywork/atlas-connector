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
environment, so one deployment can serve any number of tenants and an added
tenant is a form someone fills in. Connectors must not persist raw credentials;
when an upstream requires session reuse, cache only short-lived tokens under a
one-way credential digest, as the ESB Core example does.

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

There is nothing to obtain for `ATLAS_CONNECTOR_TOKEN`: you mint it (`openssl
rand -hex 24`), set it on the connector, and paste the same value into the Token
field when registering the source in Atlas.

`SqlConnector` implements every protocol method over `run()`: `check`
(`SELECT 1`), discovery, streaming queries, `size`, `count`, `cardinality`,
`linkHitRate`, and GROUP BY pushdown. Pools are cached per credential set, and
an evicted pool closes only once the last request holding it is done. The
capability doc, including the default `databaseUrl` credential, is **derived
from the catalog and flavor**, so the connector can never advertise an operator
its builders won't render.

## Quickstart: a REST / ERP API

Extend `AtlasConnector`. Three methods carry everything the source alone knows:

| method           | you return                                                                         |
| ---------------- | ---------------------------------------------------------------------------------- |
| `check(req)`     | nothing; throw if `req.credentials` are wrong, and the tenant reads it              |
| `query(req)`     | batches of rows (≤5000 each): push what the API filters, `applyFilters()` the rest  |
| `discovery(req)` | the API's entities as `{ tables, warnings? }`                                       |

`size(req)` is the fourth, and it is strongly recommended: the table's total
from the upstream's own metadata in one request (`totalResults`, `result.count`,
a Lark `total`, a `recordCount`), `exact: false` for an estimate, `null` for a
table that has no total. Leave it out and Atlas has to pull the table to its cap
plus one row to learn how big it is.

`count`, `aggregate`, `cardinality` and `linkHitRate` are optional overrides
with **no default bodies**. A method you do not write is a route `serve()` never
mounts and an entry the capability doc never lists, so Atlas measures the fact
itself instead of trusting a number the connector guessed. Write one only where
the upstream does the math: a count endpoint, a GROUP BY, a `COUNT DISTINCT`, a
LEFT JOIN.

`serve()` owns bearer auth, body parsing, timeouts, heartbeats, and the error
envelope. The kit meets you halfway: `applyFilters` evaluates residual filters
in memory with exactly the SQL engine's semantics, `assertKnownFields` turns a
filter you cannot answer into a 422 (rows that skipped a filter read as rows
that matched it), and `cardinalityFromValues` / `columnTally` / `linkFromValues`
turn fetched values into measurement answers.

A REST connector declares one `Pushdown` map (the same object `query()` reads
to build the upstream request), and `defineCapability` emits `operators`, `sort`,
`offset` and `join` from it, so an advertised op is always an op you push. The
rest of the doc is the vendor block no code can introspect: `limits`
(`pageSizeMax`, `rowsPerTableMax`, `concurrency`, `offsetMax`), `keysEnforced`,
`dateBucket`, `credentialSchema`, `slug`, `dialect`. `endpoints` is never typed
by an author: `serve()` fills it from the methods above at boot. See
[`examples/lark`](examples/lark) for a metadata-led REST source and
[`examples/esb`](examples/esb) for a complete fixed-catalog ERP connector with
strict envelopes, partial discovery, paging, sorting, and process-local token
coordination.

Declare metadata once, then use it for discovery, field lookup, and residual
filtering. Static APIs and fields fetched at runtime use the same functions:

```ts
import { defineCatalog, discoverFields, field, fieldTypes } from "@futurity/atlas-connector";

const companies = {
  name: "companies",
  columns: [
    field("id", "number", { nullable: false, unique: true }),
    field("code", "string", { nullable: true }),
  ],
};
const catalog = defineCatalog([companies]);
const fields = discoverFields(companies.columns);
const types = fieldTypes(companies.columns);
```

`field` defaults to non-nullable, non-unique, and an empty description. Declare
uniqueness only when the source guarantees it; sampled distinct values are not
a constraint. Catalogs preserve provider-specific table and column properties.
Lark derives fields from tenant metadata; SQL adds storage spelling with `col`.
Bind filters against your discovered types, never against the `fieldTypes` a
request carries.

Sorting requires collecting every matching row before offset and limit; it does
not make a paginated upstream globally sorted. Keep nulls last in both
directions. Normalize legitimately missing cells at ingestion, and never mask a
missing required field as null.

## The protocol

A connector serves one unauthenticated GET,
`/.well-known/futurity/atlas.json` (the capability doc), plus three
bearer-guarded POST endpoints every connector has (`/check`, `/discovery`,
`/query`) and five served only where the method behind them is overridden
(`/size`, `/count`, `/aggregate`, `/cardinality`, `/linkHitRate`). `/query`
answers NDJSON and nothing else; there is no drained form. Its first line is
always `{"served":{"filters":bool,"sort":bool,"window":bool}}`, what the
upstream applied for that one query, and the rows follow. Every POST body
carries `credentials` and `timeoutMs`. The Zod schemas in
[`src/wire/schemas.ts`](src/wire/schemas.ts) (requests, answers, stream lines)
and [`src/wire/atlas-json.ts`](src/wire/atlas-json.ts) (the capability doc) are
the wire contract, executably. [`examples/`](examples) holds four complete
connectors across the SQL and REST/ERP paths. Before registering a connector
with Atlas, grade it with the `atlas-conform` conformance runner.

## API reference

### `@futurity/atlas-connector`

**Vocabulary** (`ATLAS_TYPES`/`AtlasType`, `AtlasValue`, `OPS`/`Op`, `Filter`,
`UserSort`, `JoinField`, `DATE_GRAINS`/`DateGrain`, `SourceRow`): the shared
protocol types. `SourceRow` is the wire-legal row a connector returns:
`Record<string, string | number | boolean | null>`. `AtlasNumeric`,
`AtlasBoolean`, `AtlasDate`, and `AtlasDatetime` validate a scalar once its
catalog type is known.

**Wire schemas**: every request (`CheckRequest`, `DiscoveryRequest`,
`NativeQueryRequest`, `NativeQueryStreamRequest`, `CountRequest`, `SizeRequest`,
`AggregateRequest`, `CardinalityRequest`, `LinkHitRateRequest`), `Credentials`,
every answer (`CountAnswer`, `SizeAnswer`, `CardinalityAnswer`,
`DiscoveryAnswer`, ...), `StreamLine`, `WireError`, and the result types
(`DiscoveredTable`, `EntitySize`, `TableCardinality`, `ColumnCardinality`,
`LinkHitRate`, ...). `CONNECTOR_LIMITS` holds the protocol's size and heartbeat
bounds. `AtlasJson`, `CapabilityDoc`, `SourceCapabilitiesWire`,
`ConnectorLimitsWire`, `CONNECTOR_ENDPOINTS`, `CredentialField`,
`ATLAS_JSON_PATH` describe the capability doc.

**`AtlasConnector`**: the class to inherit. Five members are abstract (`slug`,
`capabilities`, `check`, `query`, `discovery`) and five are optional overrides
with no default body: `size` (strongly recommended), `count`, `aggregate`,
`cardinality`, `linkHitRate`. The ones you write become the doc's `endpoints`
and the routes `serve()` mounts.

**The served plan**: `query()` yields row batches, and may yield one
`{ served }` chunk before the first batch (`QueryChunk`, `Served`). It is the
connector's account of that one request: `filters` true means every `and`/`or`
predicate was applied upstream with Atlas's own semantics, so the rows are the
matching set and not a superset; `sort` true means they arrive in the requested
order; `window` true means `offset`/`limit` were applied and no row exists past
them. Yield nothing and Atlas reads `SERVED_NOTHING`, a superset it filters,
sorts and windows itself. A claim is a promise: never window rows whose filter
or order you left to the host, and the serve layer clamps a window claimed over
an unserved filter or order back to false. Atlas answers a fully served query
straight off the wire: a top-N becomes one request instead of a whole-entity
pull.

**Catalog**: `field(name, type, { nullable?, unique?, description? })`,
`defineCatalog(tables)` with `getTable` / `getColumn`, `fieldTypes(fields)`, and
`discoverFields(fields)`. `Field` derives from the discovery wire contract and
`Catalog<T>` retains table extensions; a duplicate table or field name throws at
construction, never at request time. Samples and statistics are the connector's
to add: spread a `discoverFields` result to set `samples` or `sourceColumn`.

**`serve(connector, { token, port?, hostname? })`**: boots the HTTP server;
returns `{ app, url, stop }`. Boot-fails on a token under 32 chars or an
invalid capability doc. `createApp(connector, { token })` returns the Elysia
app for tests and embedding.

**Errors and http**: `ConnectorError` plus the constructors `badRequest`,
`unauthorized`, `unknownEntity`, `unsupported`, `timeout`; `parseBody`
(400 envelope, never 422), `withTimeout` (408 on expiry), `bearerGuard`
(timing-safe compare), `ndjsonStream` (heartbeats, `{served}`/`{rows}`/`{ping}`/
`{error}`/`{end:1}` framing).

**Kit**: `applyFilters(rows, { and, or? }, fieldTypes?)` evaluates filters in
memory with the SQL engine's exact semantics (`nin` keeps nulls, empty `in`
matches nothing, ...), over `byteOrderCompare` and `decimalCompare`, which are
exported for a connector that orders rows itself. `assertKnownFields(req,
fields)` rejects unknown filter, projection, and sort fields with 422 before
fetching rows and returns their validated `Set<string>` for upstream field
selection. `windowRows(batches, req)` applies offset and limit to
already-filtered batches, emits at most 5000 rows per batch, and closes the
source iterator on early exit. Sort before windowing when requested; project
afterward. Only sorting needs whole-result buffering, and pagination and
deadline checks stay with the connector.
`defineCapability(...)` emits the capability doc from a `Pushdown` map plus the
vendor block; `pushdownCapabilities` is the emitter alone and
`pushedOps(map, entity, field?)` is what `query()` asks before it builds an
upstream request, so the doc and the request cannot drift.
`cardinalityFromValues` and `linkFromValues` compute measurement answers from
fetched values; `columnTally` is the streaming twin of the first, folding
batches into a group map instead of holding the column. `ORPHAN_SAMPLE_CAP`
bounds the orphan spellings a link answer names.

### `@futurity/atlas-connector/sql`

**`SqlConnector<Pool>`**: implements every protocol method from
`openPool(credentials)` / `run(pool, sql, params)` / `closePool(pool)` plus a
`catalog`, `schema`, and `flavor`. Pools are cached per credential set (LRU,
16 tenants) and an evicted pool closes only after the last request holding it
returns. Optional `streamBatches` override for drivers with real cursors;
`keysEnforced = true` only when every declared key is a real db constraint.
`capabilities()` derives the doc; override `credentialSchema` when the driver
takes separate parts instead of one url, keeping a `placeholder` and a `help`
string on each part.

**Catalog**: `defineCatalog(tables)`, `col(name, wire, type, opts?)`, and the
`Catalog`/`Table`/`Column`/`WireKind` types. `defineCatalog` is re-exported from
the core catalog, and `Column` extends core `Field` with SQL storage metadata.

**`SqlFlavor`**: the dialect seam (placeholders, ident quoting, date
rendering, collation pins). It ships `postgres()`; other dialects land here.

**Builders**: `buildSelect`, `buildCount`, `buildAggregate`, `buildWhere`,
`renderRows`, `renderAggregateRows`, `projectExpression`, `renderValue`,
`Binder`, plus the measurement/discovery SQL (`size`, `cardinality`,
`linkHitRate`) and `sqlCapability`. Protocol law (null ordering, empty-`in`,
LIKE escaping, 2^53 fencing, decline-vs-wrong-answer for aggregates) is
hardcoded; only spellings go through the flavor.

## License

MIT
