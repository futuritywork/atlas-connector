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

- **ESB Core API username**: surrounding whitespace is ignored.
- **ESB Core API password**: passed exactly as entered, including whitespace.

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

- `ATLAS_CONNECTOR_TOKEN`: required bearer token, at least 32 characters.
- `PORT` or `CONNECTOR_PORT`: listening port from 1 through 65535; `PORT` wins
  and the default is `4100`.

Check the public capability document:

```sh
curl http://localhost:4100/.well-known/futurity/atlas.json
```

All data endpoints require the bearer. Register the served URL and bearer as an
External Connector source in Futurity; the ESB username/password fields then
come from this connector's capability document.

## Query behavior

Every filter ESB itself can apply is a query param, and the catalog carries the
map from an Atlas field and op to that param. `query()` builds the upstream
request from it; whatever the map cannot spell stays a residual the host applies
over the rows this connector returns. The connector filters nothing locally.

The map is measured, not read off the apidoc. That document lists params for 10
of the 39 objects, names params the endpoint ignores, and omits ones it honours
(`/product/list` takes `categoryID` while documenting no params at all). Worse,
ESB answers **200 and the whole collection** for a param it does not know, so a
wrong entry reads as a filter that matched everything. Every entry was therefore
proved against a live tenant (the param narrowed, and every row it returned
carried the value asked for), and discovery re-proves each one per tenant before
`query()` is allowed to send it.

The map covers five shapes:

- `eq` on an id column (`branchID`, `supplierID`, `statusID`, `locationID`,
  `categoryID`, `subCategoryID`, `bomTypeID`, `currencyID`, …);
- `in` on the plural param (`branchIDs=1,2`), where the comma form was proved a
  union: `/purchase/purchase-invoices` and `/purchase/simple-purchase` answer
  500 to it, so those objects declare `eq` only;
- `gte`/`lte`/`eq` on the object's own date column through the `dateFrom` and
  `dateTo` pair, whose target column was disambiguated per object
  (`/purchase/purchase-order` filters `purchaseDate`, not `requiredDate`). ESB
  reads the pair as one range and matches **nothing** when only one end is set,
  so a one-sided bound rides with the far end of the calendar (`1900-01-01` /
  `2100-12-31`). `gt` and `lt` are exclusive and the params are not, so they stay
  home and the host applies them to the narrowed superset;
- `eq` on a document number or a text column, which ESB matches as a
  **substring**: the param still narrows the walk, but the rows are a superset
  and the host re-applies the filter;
- one `sort` key, per column, from the `sortFields` each object was measured to
  order by. A field outside that list is ignored upstream with a 200, so it is
  never sent; `/product/list` orders by `productCode` but answers 500 to
  `sort=productID`.

Ascending pushes only on a non-nullable column: ESB orders nulls first
ascending and last descending, and Atlas wants them last either way.

Offset and limit are applied only when the upstream answered the request
exactly: every filter pushed, the sort pushed, no or-group. Then the walk jumps
straight to the page holding the offset and asks for only the rows in the window,
so a top-N is one request. Otherwise the rows are a superset and windowing them
would drop rows the host still has to filter, so the walk runs from page 1 and
the host owns the window.

`planQuery` returns that verdict as `served: { filters, sort, window }` and
`query()` yields it as the stream's first line, so the host knows which of the
three it still owns instead of assuming it owns all of them.

Beyond that, the connector:

- reads paged ESB endpoints at 1,000 rows per request, dropping to 500 or 200 on
  the endpoints measured as slow per row (`/receipt`, `/simple-transfer`,
  `/inventory/goods-receipt`, `/inventory/goods-transfer-request`, `/supplier`,
  `/purchase/advance-payment`), and reads the three direct endpoints once; ESB
  caps no `limit`, so a page size is a latency budget, not a server limit, and
  the declared `pageSizeMax` of 1,000 is that walk's page, which is what a host
  pull through here costs;
- follows the documented `next` continuation even across empty pages, with a
  hard 20,000-page guard;
- validates response envelopes, page metadata, and requested row values against
  catalog-derived Zod schemas;
- converts ISO 8601 datetime cells carrying `Z` or a numeric offset to UTC,
  while preserving zone-less values unchanged;
- exposes date-only fields documented as `YYYY-MM-DD` as Atlas `date` values;
- leaves aggregate and join pushdown unimplemented, so the host folds and joins.

## The negative control at discovery

Discovery reads one page per catalog endpoint, which doubles as the availability
probe and the row count. It then spends one more request per mapped param: a
value no tenant holds (`987654321`, `ATLASNEGATIVECONTROL0`, or the window
1900-01-01..1900-12-31) that **must** narrow `result.count`. A param that leaves
the count untouched is dropped for this tenant, reported as a discovery warning,
and never sent again by this process.

A 4xx on the control value counts as honoured, not dropped: an unknown param is
ignored with a 200, so a rejection is itself proof the endpoint reads the param
(`statusID=987654321` answers `EC03100003 Validation Error` where the status does
not exist). A 5xx is not: that is how `/purchase/purchase-invoices` answers a
comma-separated `supplierIDs`. An empty collection cannot falsify anything, so its
params stand as declared.

## Counts and sizes

Every paged ESB response carries `result.count`, the total across all pages under
the params sent, so:

- `/size` is one `limit=1` request with no params; the three direct endpoints
  count the array they return, and a paged response without a `count` answers
  null rather than guessing;
- `/count` is one `limit=1` request under the pushed params, but only when every
  filter in the request is pushable. A residual would leave that number counting a
  superset, so the connector declines with a 422 and the host tallies `/query`,
  where it applies the residual itself.

The apidoc describes that field inconsistently across its paged GETs ("Total
number of records", "Total number of records found", "Total of data per page
information"), so it was checked against a live tenant: on all 21 non-empty
paged objects `count` is invariant across `limit` and equals the rows a full walk
returns (`/production/simple-manufacturing` reports 22,156 at every limit from 1
to 100,000, and a 23-page walk returned 22,156 distinct keys). Under a filter it
tracks the filter (`supplierID=154` on `/purchase/purchase-invoices` takes 3,286
to 355).

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
