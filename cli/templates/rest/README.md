# my-atlas-connector

An Atlas external connector backed by a REST/ERP API. You extend
`AtlasConnector` and implement upstream reads; the profiling five derive themselves
from your `query()`. `serve()` owns auth, timeouts, NDJSON framing, and the
error envelope; your methods receive the parsed request and return plain data.

Every request carries `credentials`, the tenant's own upstream secrets, so
one deployment serves many tenants and stores nothing between calls.

## Fill in (`src/connector.ts`)

Every `YOUR CODE HERE` site carries its contract. Complete these methods and
replace the sample catalog with your API's fields:

| method     | returns                                                             |
| ---------- | ------------------------------------------------------------------- |
| `check`    | nothing; throws if the credentials are wrong (the tenant reads it)  |
| `query`    | batches of rows: push what your API filters, `applyFilters()` the rest |
| `count`    | how many rows match the filters                                     |
| `discover` | supplied from the catalog; fetch tenant metadata first for dynamic APIs |

Declare fields once with SDK `field(name, type, { nullable, unique, description })`
and `defineCatalog()`. Discovery uses `discoverFields(table.columns)`; local
filtering uses `fieldTypes(table.columns)` with `applyFilters(batch, req, types)`.
Both therefore use the same names and Atlas types. `nullable` and `unique`
default to `false`; set them to match the upstream contract.

`profileColumns`, `profileLink`, `profileGrain`, `exactCount`, and
`sampleColumnValues` scan through `query()` on the base class and are already
correct. Override one only to make it cheaper: a source-side `COUNT DISTINCT`,
a total your API returns on a page. `aggregate()` declines with a 204 until you
implement it and add `"aggregate"` to `endpoints`.

Unknown filter, projection, or sort fields must throw `unsupported` (422).
`assertKnownFields(req, fields)` from the kit enforces this in `query` and
`count`. Rows that skipped a filter look like rows that matched it.

## The honesty contract (`src/capability.ts`)

The capability doc is authored by hand because only you know what your
pushdown + `applyFilters` combination honors. Every flag is earned: an
advertised op that `query()` silently drops corrupts answers downstream. Start
narrow, widen as you implement.

`credentialSchema` is the other half: it is exactly the form Atlas shows a
tenant, and exactly the keys `req.credentials` will carry back. A field is
`text`, `password` (masked) or `textarea` (a multi-line box for a pasted key),
and `required: false` marks one a tenant may leave blank, which then arrives
with the key absent. Each field's `help` is short markdown rendered between its
label and its input, so write it for the person filling the form in: name the
exact page in the vendor's console the value comes from and link the vendor's
doc for it.

## Run

```sh
cp .env.example .env   # ATLAS_CONNECTOR_TOKEN: mint one, openssl rand -hex 24; atlas gets the same value
bun install
bun run start          # serves on :4100
```

Check it answers:

```sh
curl http://localhost:4100/.well-known/futurity/atlas.json
```

Then point `atlas-conform` at it to grade the wire behaviour before registering
the connector with Atlas.
