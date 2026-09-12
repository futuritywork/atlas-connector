# lark-atlas-connector

an atlas external connector for lark base (bitable), built on `@futurity/atlas-connector`. tables →
atlas tables, fields → columns, `records/search` → rows.

one process serves every tenant. a tenant's app id, app secret, and base `app_token` arrive on each
request, so nothing about a base is configured here and nothing about a base is stored between calls.

## run

```sh
cp .env.example .env   # ATLAS_CONNECTOR_TOKEN: mint one, openssl rand -hex 24; atlas gets the same value
bun install
bun run start          # serves on :4100
bun run check          # tsc --noEmit
```

```sh
curl http://localhost:4100/.well-known/futurity/atlas.json
```

the doc's `credentialSchema` is what atlas renders in the connect form. each entry's `placeholder`
fills the empty input and its `help` is markdown shown between the label and the input, naming the
console page the value is copied from. every lark field is `required: true`; a field marked
`required: false` may be left blank and then arrives with its key absent:

```json
[
  {
    "key": "appId",
    "label": "App ID",
    "type": "text",
    "required": true,
    "placeholder": "cli_XXXXXXXXXXXXXXXX",
    "help": "Lark Developer Console → your app → **Credentials & Basic Info**, the field labelled **App ID**. Your apps are listed at [open.larksuite.com/app](https://open.larksuite.com/app)."
  },
  {
    "key": "appSecret",
    "label": "App secret",
    "type": "password",
    "required": true,
    "help": "The **App Secret** on that same **Credentials & Basic Info** page of the [Lark Developer Console](https://open.larksuite.com/app). The app also needs the `bitable:app:readonly` permission."
  },
  {
    "key": "appToken",
    "label": "Base app token",
    "type": "text",
    "required": true,
    "placeholder": "bascnXXXXXXXXXXXXXXXXXXXXXX",
    "help": "The id in the base's URL, `https://<tenant>.larksuite.com/base/<app_token>`. Add the app to that base as a collaborator first, or it cannot read the tables."
  }
]
```

prove a credential set before anything else:

```sh
curl -sS -X POST http://localhost:4100/check \
  -H "authorization: Bearer $ATLAS_CONNECTOR_TOKEN" -H 'content-type: application/json' \
  -d '{"credentials":{"appId":"cli_xxx","appSecret":"xxx","appToken":"xxx"},"timeoutMs":10000}'
```

`check` mints a tenant token (which proves the app id and secret) and then reads the base's table
list (which proves the app token), so either half being wrong fails here with a message written for
the person who typed it.

every other route takes the same `credentials` object:

```sh
curl -sS -X POST http://localhost:4100/query \
  -H "authorization: Bearer $ATLAS_CONNECTOR_TOKEN" -H 'content-type: application/json' \
  -d '{"table":"deals","and":[{"field":"stage","op":"eq","value":"won"}],
       "sort":[],"fields":["name","amount","stage"],"limit":5,
       "credentials":{"appId":"cli_xxx","appSecret":"xxx","appToken":"xxx"},"timeoutMs":30000}'
```

need a base with data in it? `seed/` fills one with a demo dataset (`northwind` or `harbor`); see
`seed/README.md`.

## what it implements

| method | why |
| --- | --- |
| `check` | token mint + one table read |
| `query` | one `records/search` under a pushed filter and sort, or a single `GET records/{record_id}` |
| `count` | one search page's `total` when every filter pushes exactly; declined otherwise |
| `discovery` | table + field metadata; link fields become foreign keys |
| `size` | every search page carries the table's total |

`pushdown.ts` is the whole declaration of what lark evaluates: per field type, which atlas op it
pushes and whether lark's answer is atlas's answer (exact) or a wider set atlas has to trim
(superset). the capability doc's `operators` are emitted from that same table, so an advertised op
is an op `query()` pushes.

| field type | pushes | class |
| --- | --- | --- |
| number | `eq` `neq` `gt` `gte` `lt` `lte` | exact |
| single select | `eq` `neq`, value naming a live option only | exact |
| any type but checkbox | `isnull` `notnull` | exact |
| checkbox | `eq` | exact |
| text, phone, url, auto number | `eq` `includes` `startswith` | superset |
| formula, lookup | nothing: bitable rejects a condition on one | n/a |

superset because lark's text match is case-insensitive and trims the needle, and `startswith` rides
on `contains`. a single-select condition pushes only when its value names a live option: lark answers
a value that names none with `1254018 InvalidFilter` for the whole search instead of no rows.

`sort` rides on the search too. numbers, text and dates order the way atlas compares them (numeric,
code point, chronological) and bitable leaves empty cells last in both directions, which is atlas's
nulls-last rule; a single select orders by option position, not by name, so a sort touching one is
left to the host. `and[] ∧ (⋁ or-groups)` rides as one filter: bitable nests one level, so the shared
`and[]` distributes into every or-group and the whole thing goes as `conjunction: "or"` with a child
per group.

when every filter pushes exactly and every sort key pushes, the rows lark returns are the answer, so
`query()` asks for exactly `offset + limit` rows and windows them here. short of that the answer is a
superset in row set or in order, so the connector streams the narrowed rows whole and the host owns
the residual filter, the sort and the window; there is no local `applyFilters` pass.

either way the stream says so on its first line: `servedBy()` turns the filter plan and the sort plan
into `{ filters, sort, window }`, `query()` yields it before the first batch, and the host reads it to
decide whether the rows it is about to receive are already the answer. a served top-N is one search
request; an unserved one is the whole narrowed set, sized and refused against lark's reach.

`record_id` is not a filterable field upstream, so an `eq` on it is a single `GET records/{record_id}`
instead of a table walk.

`total` on a search page counts the rows matching the pushed filter, on every page and uncapped, so
`count` answers from one `page_size=1` request whenever the filter set is exact, and declines with a
422 otherwise rather than answer lark's looser number.

## deploy

this connector is one bun process: it binds `$PORT`, reads one env var, and has to be reachable over
https at a stable url. anything that runs a bun process works (railway, fly, render, a container, a
vm behind caddy or nginx).

1. check out the whole repo (the `file:../..` sdk link resolves against it) and
   `bun install --frozen-lockfile`.
2. set `ATLAS_CONNECTOR_TOKEN`: a secret you mint (`openssl rand -hex 24`, at least 32 characters).
   nobody issues it; the same value goes into the token field when you register the source in atlas.
3. start it. `bun run start` from the repo root is the hosted entrypoint, with this connector at
   `/lark-base`; `bun run start` inside `examples/lark` serves it alone at the origin root.
4. put it behind https. the base url you paste into atlas is `https://<host>/lark-base` (root
   entrypoint) or `https://<host>` (standalone), with the same bearer token.

on railway that is a service from this repo with root directory `/` and start command
`bun run start`; the generated domain already terminates https.

a base on `open.feishu.cn` needs `DOMAIN` in `src/lark-api.ts` changed and a second deploy; the
domain is a property of the connector, not of a tenant's credentials.
