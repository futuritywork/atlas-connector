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
