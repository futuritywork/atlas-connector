# my-atlas-connector

An Atlas external connector backed by a REST/ERP API. You extend
`AtlasConnector` and write the ten protocol methods yourself — five are
mandatory, five default to a wire-legal "not implemented". `serve()` owns auth,
timeouts, NDJSON framing, and the error envelope; your methods receive the
parsed request and return plain data.

## Fill in (`src/connector.ts`)

Every `YOUR CODE HERE` site carries its return contract. The mandatory five:

| method            | returns                                                        |
| ----------------- | -------------------------------------------------------------- |
| `discovery`       | your API's entities as `{ tables, warnings? }`                 |
| `query`           | rows: push what your API can filter, `applyFilters()` the rest |
| `queryStream`     | the same rows as batches (≤5000 rows each)                     |
| `count`           | how many rows match the filters                                |
| `sampleKeyValues` | sorted distinct head of a column, as text                      |

The optional five (`countExact`, `probeColumns`, `probeLink`, `probeGrain`,
`aggregate`) already answer wire-legal defaults on the base class — override
only what you implement. The probe kit does the math once you fetch values:
`columnCountsFromValues`, `linkFromValues`, `grainFromValues`.

## The honesty contract (`src/capability.ts`)

The capability doc is authored by hand because only you know what your
pushdown + `applyFilters` combination honors. Every flag is earned: an
advertised op that `query()` silently drops corrupts answers downstream. Start
narrow, widen as you implement.

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
