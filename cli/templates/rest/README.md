# my-atlas-connector

An Atlas external connector backed by a REST/ERP API. You extend
`AtlasConnector` and implement upstream reads; anything you do not implement,
Atlas measures for itself. `serve()` owns auth, timeouts, NDJSON framing, and
the error envelope; your methods receive the parsed request and return plain data.

Every request carries `credentials`, the tenant's own upstream secrets, so
one deployment serves many tenants and stores nothing between calls.

## Fill in (`src/connector.ts`)

Every `YOUR CODE HERE` site carries its contract. Complete these methods and
replace the sample catalog with your API's fields:

| method      | returns                                                             |
| ----------- | ------------------------------------------------------------------- |
| `check`     | nothing; throws if the credentials are wrong (the tenant reads it)  |
| `query`     | batches of rows: push what your API filters, `applyFilters()` the rest |
| `discovery` | `{ tables, warnings? }`; warnings are non-fatal notes the tenant reads |
| `size`      | the table's total from your API's metadata, in one request, or `null` |

Declare fields once with SDK `field(name, type, { nullable, unique, description })`
and `defineCatalog()`. Discovery uses `discoverFields(table.columns)`; local
filtering uses `fieldTypes(table.columns)` with `applyFilters(batch, req, types)`.
Both therefore use the same names and Atlas types. `nullable` and `unique`
default to `false`; set them to match the upstream contract.

`size` is the optional one of the four, and still worth writing: without it
Atlas pulls the table to its cap plus one row just to learn how big it is, which
is the difference between an answer in seconds and a refusal.

`count`, `aggregate`, `cardinality` and `linkHitRate` have **no default body**.
A method you leave out is a route that is never served and an entry the
capability doc never lists, so Atlas measures that fact itself rather than
trusting a number the connector guessed. Add one where your API does the math:
a count endpoint, a GROUP BY, a `COUNT DISTINCT`, a LEFT JOIN. Nothing else
changes; `endpoints` fills itself at boot.

Unknown filter, projection, or sort fields must throw `unsupported` (422), and
the message names the field so the tenant can fix their query.
`assertKnownFields(req, fields)` from the kit enforces this in `query` and in
any `count` you write. It returns the validated field set for upstream field
selection. Rows that skipped a filter look like rows that matched it.

Use `windowRows(filteredBatches, req)` before projection to apply offset and
limit, bound batches to 5000 rows, and close the upstream iterator on early exit.
Buffer only when sorting is requested; keep upstream pagination in your client.

Yield `{ served: { filters, sort, window } }` before the first batch. It is what
the upstream applied for this one query: `filters` only when every `and`/`or`
predicate went upstream with Atlas's semantics, `sort` only when the rows arrive
in the requested order, `window` only when both hold and `offset`/`limit` were
applied with nothing beyond them. Anything false is Atlas's to redo, and it
will. Never window rows whose filter or order you left to the host: that is the
one claim that changes which rows an answer holds. A fully served query is
answered straight off your stream, so a top-N costs one request instead of a
whole-table pull.

## The honesty contract (`src/capability.ts`)

`PUSHDOWN` is the one object that says what you send upstream, and `query()`
reads the same object (`pushedOps(PUSHDOWN, table, field)`) to decide upstream
param versus residual `applyFilters`. `defineCapability` emits `operators`,
`sort`, `offset` and `join` from it, so an advertised op is always an op you
push and the two can never drift. `{}` pushes nothing, which is honest and
works: Atlas narrows the rows itself. Widen a field only once `query()` puts it
on the wire, because an advertised op that `query()` silently drops corrupts
answers downstream.

The rest of the doc is the vendor block, hand-written because no code can
introspect it: `limits` (`pageSizeMax`, `rowsPerTableMax`, `concurrency`,
`offsetMax`) are the ceilings from the vendor's own docs, and `keysEnforced` is
true only where the upstream itself rejects a duplicate in a field you declared
unique. `endpoints` is not yours to type: `serve()` fills it from the methods
you overrode.

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
