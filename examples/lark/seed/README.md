# seed

fills one lark base with a demo dataset so the connector has something to serve.
`northwind` is a trading company (accounts 30, contacts 80, deals 60); `harbor`
is a logistics company (vessels 12, ports 15, voyages 90, incidents 20). the two
share no table names, so a cross-tenant leak is visible at a glance.

```sh
LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx LARK_APP_TOKEN=xxx \
  bun run examples/lark/seed/seed.ts --dataset northwind
```

it deletes every table in the base first, so reruns are idempotent and the row
data is identical each time. `LARK_DOMAIN` defaults to the larksuite tenant.
