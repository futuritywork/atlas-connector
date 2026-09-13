# ESB Core Atlas connector

A complete external Atlas connector for the ESB Core 2.0 REST API. It exposes
39 curated accounting, inventory, purchasing, sales, supplier, customer, and
master-data entities from `https://services.esb.co.id/core`.

The connector is multi-tenant: every Atlas request carries that tenant's
`username` and `password`. ESB credentials are never read from environment
variables or written to disk.

## ESB account setup

Create a dedicated least-privilege ESB Core API user. Grant read access only to
the entities the tenant wants Atlas to discover. The capability form asks for:

- **ESB Core API username** — surrounding whitespace is ignored.
- **ESB Core API password** — passed exactly as entered, including whitespace.

See the [ESB Core API documentation](https://developers.esb.co.id/esb-core/)
for account and endpoint details.

Connection checking proves the credentials by authenticating; it does not
require access to an arbitrary business entity. Discovery then probes all 39
catalog endpoints with bounded concurrency. An entity denied to this account,
unavailable for its ESB installation, or returning an incompatible collection
shape is omitted with a warning. Authentication, timeouts, network failures,
transient upstream failures, and unknown ESB application failures stop
discovery rather than returning a misleading partial catalog. Discovery also
fails when no supported entity is readable.

## Runtime configuration

```sh
cp .env.example .env
# mint the bearer shared by Atlas and this connector; the generated value is not written to shell history
sed -i "s/^ATLAS_CONNECTOR_TOKEN=.*/ATLAS_CONNECTOR_TOKEN=$(openssl rand -hex 24)/" .env
bun install
bun run start
```

The environment contains only:

- `ATLAS_CONNECTOR_TOKEN` — required bearer token, at least 32 characters.
- `PORT` or `CONNECTOR_PORT` — listening port from 1 through 65535; `PORT` wins
  and the default is `4100`.

Check the public capability document:

```sh
curl http://localhost:4100/.well-known/futurity/atlas.json
```

All data endpoints require the bearer. Register the served URL and bearer as an
External Connector source in Futurity; the ESB username/password fields then
come from this connector's capability document.

## Query behavior

The connector:

- follows paged ESB endpoints at 100 rows per request and reads direct endpoints
  once;
- follows the documented `next` continuation even across empty pages, with a
  hard 20,000-page guard;
- validates response envelopes, page metadata, and requested row values
  against catalog-derived Zod schemas;
- validates filter operands against catalog types before evaluating every
  advertised filter locally with the SDK's `applyFilters`;
- supports multi-column, digit-exact sorting with nulls last, offset, projection,
  limits, and scan counts;
- converts ISO 8601 datetime cells and matching filter operands carrying `Z` or
  a numeric offset to UTC, while preserving zone-less values unchanged;
- exposes date-only fields documented as `YYYY-MM-DD` as Atlas `date` values;
- leaves aggregate pushdown unadvertised and inherits the SDK's scan-based
  profiling methods.

## Token cache and deployment shape

ESB login invalidates other sessions for the same credentials. One connector
process therefore shares access and refresh tokens in memory by a SHA-256
digest of the fixed origin, normalized username, and exact password. Raw
credentials are never map keys. Concurrent requests share an in-flight token
mint, while each request keeps its own deadline, and invalid access tokens are
retried only once.

Run **one replica**. The in-memory coordinator is process-local, so horizontal
replicas can invalidate each other's ESB sessions. A multi-replica deployment
requires a shared token coordinator and is intentionally outside this example.

## Maintaining the generated catalog

`src/catalog.ts` is generated from the byte-for-byte published ESB input in
`catalog-data/api_data.json`. Its header records the source URL and SHA-256.
Both files are excluded from Prettier to preserve the source bytes and generated
output.
`catalog-data/overrides.ts` records the selected endpoints and column order,
identifier evidence, field-table corrections, type decisions, and editorial
wording. All non-key fields remain nullable; apidoc's `optional` flag does not
reliably describe nulls in response rows. Keys are inferred unless marked
`documented`, so example uniqueness is not treated as an upstream guarantee.

From this example directory, regenerate or check without network access:

```sh
bun run catalog:generate
bun run catalog:check
```

To inspect upstream drift without changing tracked files:

```sh
curl -fL https://developers.esb.co.id/esb-core/api_data.json -o /tmp/esb-api_data.json
bun run catalog:check --input /tmp/esb-api_data.json
```

A changed input hash, selected contract, or stale override makes the check fail.
The hash intentionally covers every source byte, including formatting and
unselected endpoints; a hash-only diff does not mean a runtime contract changed.
CI checks only the pinned input; it does not fetch upstream. After reviewing an
update, replace `catalog-data/api_data.json` with the downloaded bytes, reconcile
the explicit overrides, regenerate, and run `bun test` and `bun run check`.
Review the generated diff before committing. The fixed contract digest in the
generator test pins this connector's current 39 entities and 371 columns; change
it only when intentionally accepting a runtime catalog change. New upstream
fields do not silently enter the selected column list.

## Tests and conformance

```sh
bun test
bun run check
```

Before registering a deployment, grade the wire protocol:

```sh
atlas-conform \
  --mode live \
  --url http://localhost:4100 \
  --token "$ATLAS_CONNECTOR_TOKEN" \
  --credentials @/secure/path/esb-credentials.json
```

Keep credential files outside the repository and shell history. The test suite
uses mocked upstream responses and contains no ESB secrets.
