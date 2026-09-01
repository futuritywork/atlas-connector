# lark-atlas-connector

an atlas external connector for lark base (bitable), built on
`@futurity/atlas-connector`. tables → atlas tables, fields → columns,
`records/search` → rows.

one process serves every tenant. a tenant's app id, app secret, and base
`app_token` arrive on each request, so nothing about a base is configured here
and nothing about a base is stored between calls.

## run

```sh
cp .env.example .env   # ATLAS_CONNECTOR_TOKEN only, 32+ chars
bun install
bun run start          # serves on :4100
bun run check          # tsc --noEmit
```

```sh
curl http://localhost:4100/.well-known/futurity/atlas.json
```

the doc's `credentialSchema` is what atlas renders in the connect form. each entry's
`placeholder` fills the empty input and its `help` is markdown shown underneath, naming the
console page the value is copied from:

```json
[
  {
    "key": "appId",
    "label": "App ID",
    "type": "text",
    "placeholder": "cli_XXXXXXXXXXXXXXXX",
    "help": "Lark Developer Console → your app → **Credentials & Basic Info**, the field labelled **App ID**. Your apps are listed at [open.larksuite.com/app](https://open.larksuite.com/app)."
  },
  {
    "key": "appSecret",
    "label": "App secret",
    "type": "password",
    "help": "The **App Secret** on that same **Credentials & Basic Info** page of the [Lark Developer Console](https://open.larksuite.com/app). The app also needs the `bitable:app:readonly` permission."
  },
  {
    "key": "appToken",
    "label": "Base app token",
    "type": "text",
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

`check` mints a tenant token (which proves the app id and secret) and then reads
the base's table list (which proves the app token), so either half being wrong
fails here with a message written for the person who typed it.

every other route takes the same `credentials` object:

```sh
curl -sS -X POST http://localhost:4100/query \
  -H "authorization: Bearer $ATLAS_CONNECTOR_TOKEN" -H 'content-type: application/json' \
  -d '{"table":"deals","and":[{"field":"stage","op":"eq","value":"won"}],
       "sort":[],"fields":["name","amount","stage"],"limit":5,
       "credentials":{"appId":"cli_xxx","appSecret":"xxx","appToken":"xxx"},"timeoutMs":30000}'
```

need a base with data in it? `seed/` fills one with a demo dataset (`northwind`
or `harbor`); see `seed/README.md`.

## what it implements

| method                                 | why                                                      |
| -------------------------------------- | -------------------------------------------------------- |
| `check`                                | token mint + one table read                              |
| `query`                                | pushdown-narrowed scan, `applyFilters` for the residual  |
| `count`                                | scan-and-tally: lark's filtered total skips the residual |
| `discover`                             | table + field metadata; link fields become foreign keys  |
| `exactCount`                           | every search page carries the table's total              |
| `profileColumns` / `profileLink` / `profileGrain` / `sampleColumnValues` | left to the base class, which scans through `query()`    |

lark filters day-granular dates and cannot filter formula or lookup fields at
all, so `pushdown.ts` pushes only what lark evaluates the way atlas does, and
`query()` always re-runs the whole filter set locally.

## deploy to railway

this connector is a bun/elysia server; railway gives it a public https url, which is what atlas needs.

1. new railway service from this repo, **root directory `examples/lark`** (the `file:../..` link to the sdk resolves because railway clones the whole repo). start command `bun run start`.
2. set one env var: `ATLAS_CONNECTOR_TOKEN` (a ≥32-char secret, the bearer atlas will send).
3. it binds `$PORT` automatically. railway's generated `https://<name>.up.railway.app` is the url you paste into atlas as an external connector, with the same bearer token.

a base on `open.feishu.cn` needs `DOMAIN` in `src/lark-api.ts` changed and a second deploy;
the domain is a property of the connector, not of a tenant's credentials.
