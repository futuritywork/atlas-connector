# Brightline CRM — reference Atlas external connector

The worked example a connector author copies from. It is backed by Postgres, which is the
point — a SQL-shaped source declares its catalog, provides one `run(sql, params)`, and the
SDK derives all ten protocol endpoints, the server, auth, timeouts, and the NDJSON framing.

The whole connector is four small files:

```
src/
  env.ts        # config surface (port, database url, schema, token)
  catalog.ts    # the CRM schema as defineCatalog(...) — names, types, keys, FK edges
  connector.ts  # class BrightlineConnector extends SqlConnector: run() + a pg cursor stream
  index.ts      # serve(new BrightlineConnector(), { token, port })
scripts/
  seed.ts       # schema + deterministic CRM seed
```

## What it models

A small B2B sales CRM in one Postgres schema (`crm`), five tables (~85k rows):

| table      | rows   | planted characteristic                                                                                  |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------- |
| owners     | 24     | one declared `UNIQUE` (email) — the constraint key tier                                                 |
| companies  | 2,400  | `erp_account_code` cross-source join key; ~40 case-pair names; `domain` near-unique with 6 dup pairs    |
| contacts   | 14,000 | `email` near-unique blemished (distinct/nonNull ≈ 0.9991); `company_id` ~1.5% orphans with **no** pg FK |
| deals      | 9,000  | `amount` with scale-spelling twins and one > 2^53 sentinel; clean `company_id` FK                       |
| activities | 60,000 | `deal_id` fan-out (distinct << rows); `tags text[]` for the `contains` op                               |

The seed is deterministic (a seeded PRNG), so the same seed always yields the same probe
numbers. The planted values (case pairs, orphan ids, duplicate emails) are emitted by
explicit loops, never left to chance.

## Run it

Prerequisite: a Postgres reachable at `CONNECTOR_DATABASE_URL` (default expects one on
localhost:5434, user/pass `postgres`/`postgres`).

```bash
bun install

# 1. create the `brightline` database, build schema `crm`, load the seed.
#    (the seed creates the database itself if it does not exist)
bun run seed

# 2. start the connector on port 4100
bun run start
```

Environment: see `.env.example` — every value has a local default.

## A few live calls

```bash
TOK='Authorization: Bearer brightline-dev-token-0123456789abcdef'
CT='Content-Type: application/json'
U=http://localhost:4100

curl -s $U/.well-known/futurity/atlas.json

curl -s -H "$TOK" -H "$CT" -X POST $U/count \
  -d '{"table":"deals","and":[{"field":"stage","op":"eq","value":"closed_won"}],"timeoutMs":5000}'

curl -s -H "$TOK" -H "$CT" -X POST $U/probe/columns \
  -d '{"table":"contacts","columns":["email"],"timeoutMs":15000}'
```
