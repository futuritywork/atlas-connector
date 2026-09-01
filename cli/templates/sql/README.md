# my-atlas-connector

An Atlas external connector backed by a SQL database. `SqlConnector` implements
every protocol method from two things you provide: a catalog, and a pool it can
run statements on.

Every request carries `credentials`, here the tenant's `databaseUrl`, so one
deployment serves many databases and stores none of them.

## Fill in

1. **`src/catalog.ts`**: declare your tables. `wire` is how the column's
   storage crosses the wire, `type` is what Atlas binds against, and
   `unique: true` is a promise: set it only for a real db unique/pk constraint.
2. **`src/connector.ts`**: `openPool` / `closePool` / `run`. As scaffolded
   they are a working postgres connector over Bun's `SQL`; another driver swaps
   those three and nothing else. Values bind positionally (`$1..$n`); never
   interpolate them into the sql text.

That is the whole connector. `check` is a `SELECT 1` on the tenant's pool.
Discovery, queries, streaming, counts, probes, and aggregates are all built from
those pieces, and the served capability doc is derived from the catalog: an op
the builders can't render is never advertised. To narrow it further, override
`capability()`:

```ts
override capability() {
  const doc = super.capability();
  return { ...doc, capabilities: { ...doc.capabilities, join: false } };
}
```

## Run

```sh
cp .env.example .env   # set ATLAS_CONNECTOR_TOKEN to a 32+ char secret
bun install
bun run start          # serves on :4100
```

Check it answers, and prove a database url reaches your database:

```sh
curl http://localhost:4100/.well-known/futurity/atlas.json

curl -X POST http://localhost:4100/check \
  -H "authorization: Bearer $ATLAS_CONNECTOR_TOKEN" -H 'content-type: application/json' \
  -d '{"credentials":{"databaseUrl":"postgres://user:pass@localhost:5432/mydb"},"timeoutMs":5000}'
```

Then point `atlas-conform` at it to grade the wire behaviour before registering
the connector with Atlas.
