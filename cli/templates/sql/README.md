# my-atlas-connector

An Atlas external connector backed by a SQL database. `SqlConnector` implements
all ten protocol methods from two things you provide: a catalog and one
`run(sql, params)`.

## Fill in

1. **`src/catalog.ts`** — declare your tables. `wire` is how the column's
   storage crosses the wire, `type` is what Atlas binds against, and
   `unique: true` is a promise: set it only for a real db unique/pk constraint.
2. **`src/connector.ts`** — the `run()` method: execute one parameterized
   statement against your database and return the rows. Values bind
   positionally (`$1..$n`); never interpolate them into the sql text.

That is the whole connector. Discovery, queries, streaming, counts, probes,
and aggregates are all built from those two pieces, and the served capability
doc is derived from the catalog — an op the builders can't render is never
advertised. To narrow it further, override `capability()`:

```ts
capability() {
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

Check it answers:

```sh
curl http://localhost:4100/.well-known/futurity/atlas.json
```

Then point `atlas-conform` at it to grade the wire behaviour before registering
the connector with Atlas.
