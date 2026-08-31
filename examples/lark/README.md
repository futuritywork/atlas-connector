# lark-atlas-connector

an atlas external connector for one lark base (bitable), built on
`@futurity/atlas-connector`. tables → atlas tables, fields → columns,
`records/search` → rows. see `LARK-CONNECTOR.md` for the feasibility
assessment, mapping tables, and what still needs a live lark app.

## run

```sh
cp .env.example .env   # fill lark app creds + base app_token + bearer
bun install
bun run start          # serves on :4100
bun run check          # tsc --noEmit
```

```sh
curl http://localhost:4100/.well-known/futurity/atlas.json
```

## deploy to railway

this connector is a bun/elysia server; railway gives it a public https url, which is what atlas needs.

1. new railway service from this repo, **root directory `examples/lark`** (the `file:../..` link to the sdk resolves because railway clones the whole repo). start command `bun run start`.
2. set env: `ATLAS_CONNECTOR_TOKEN` (a ≥32-char secret — the bearer atlas will send), `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_APP_TOKEN`, optionally `LARK_DOMAIN` (`https://open.feishu.cn` for the china tenant).
3. it binds `$PORT` automatically. railway's generated `https://<name>.up.railway.app` is the url you paste into atlas as an external connector, with the same bearer token.
