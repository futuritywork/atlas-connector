# lark base → atlas connector: feasibility + skeleton

date: 2026-08-30. api facts verified against open.larksuite.com / open.feishu.cn docs,
then against two live seeded bases through one running connector.

## verdict

lark base (bitable) is a good atlas connector target — the best queryable surface in the
lark suite by far. it is genuinely tabular: base (app_token) → tables (table_id) → records
(record_id) with typed fields, a search api with server-side filtering + sorting + pagination
+ a total count, and a metadata api that enumerates tables and fields. a base is named by an
`app_token` the tenant sends on every request, so one running connector serves any number of them.

what's clean:

- `record_id` is a real, source-enforced primary key on every table → `enforcesDeclaredKeys: true`.
- link fields (`singleLink`/`duplexLink`) carry `property.table_id` → honest foreign keys to the
  target table's `record_id`, so atlas gets a join graph for free at discovery.
- search response carries `total` → cheap `exactCount`.
- field metadata is rich (type code + ui_type + options), so discovery needs no sampling
  heuristics to type columns.

what's awkward:

- filter pushdown is shallow: one conjunction level, ≤50 conditions, string-array values,
  per-type operator restrictions, and formula/lookup fields cannot be conditions at all.
  everything non-pushable is a full table scan + `applyFilters`.
- date filters are day-granular upstream (`["ExactDate", "<ms>"]`, `Today`, …) while atlas
  datetimes are millisecond iso — pushing date comparators would change semantics, so dates
  only push `isEmpty`/`isNotEmpty` and comparators run locally.
- cell values are not scalars: text is a segment array, url is `{link,text}`, person is an
  object array, formula/lookup is `{type,value}` — every read goes through a flattener.
- scale ceiling: page_size 500, 20 rps per app. a 50k-row table is ~100 sequential pages
  (~5-10s per full scan); fine for bases, wrong tool for millions of rows.
- no server-side aggregation of any kind → aggregate declines (204), atlas aggregates locally.
- tables and fields are addressed by display name (unicode, mutable, not unique-guaranteed);
  renames break the contract until rediscovery. field_name is also the filter key, so the
  name→id indirection can't be avoided on the filter path.

## auth

- custom app: `app_id` + `app_secret` from the developer console.
- `POST /open-apis/auth/v3/tenant_access_token/internal` `{app_id, app_secret}` →
  `{code, msg, tenant_access_token, expire}`; expire ≈ 7200s, max 2h. re-requesting inside the
  last 30 min issues a fresh token and both stay valid — so cache with slack (we refresh 5 min
  early) and invalidate on token-expired codes (99991661/63/64/68), retry once.
- scopes: `bitable:app:readonly` (or `base:record:retrieve` + `base:table:read` + `base:field:read`).
- the app must be able to see the base: add the app as a collaborator of the base/doc (or
  install with sufficient org-wide doc access). this is the step people forget; api answers
  91402/permission errors until it's done.

## field type mapping (lark type code → atlas)

| code | lark            | atlas    | read-side flatten                              |
|------|-----------------|----------|------------------------------------------------|
| 1    | text            | string   | join `[{text,type}]` segments                  |
| 2    | number          | number   | raw number (currency/progress/rating share it) |
| 3    | single select   | string   | option name                                    |
| 4    | multi select    | array    | json text of option names                      |
| 5    | date            | datetime | ms epoch → iso-8601 utc                        |
| 7    | checkbox        | boolean  | raw bool                                       |
| 11   | user            | json     | json text of `[{id,name,…}]`                   |
| 13   | phone           | string   | raw string                                     |
| 15   | url             | string   | `.link` (fallback `.text`)                     |
| 17   | attachment      | json     | json text                                      |
| 18   | single link     | string   | first of `link_record_ids` (the join key)      |
| 19   | lookup          | json     | unwrap `{type,value}`, segments → text         |
| 20   | formula         | json     | unwrap `{type,value}`, segments → text         |
| 21   | duplex link     | string   | first of `link_record_ids` (the join key)      |
| 22   | location        | json     | json text                                      |
| 23   | group chat      | json     | json text                                      |
| 1001 | created time    | datetime | ms epoch → iso                                 |
| 1002 | modified time   | datetime | ms epoch → iso                                 |
| 1003 | created user    | json     | json text                                      |
| 1004 | modified user   | json     | json text                                      |
| 1005 | auto number     | string   | raw string                                     |

plus a synthetic `record_id` string column on every table: primary key, unique, non-null.
empty cells are omitted from the record's fields map entirely → read as null.

## operator mapping (atlas op → lark search operator)

pushed conditions only narrow the fetch; `query()` always re-applies the full filter set via
`applyFilters`, so pushdown can never change semantics — only save pages.

| atlas op    | number | text/phone/url/auto# | single select | checkbox | date | multi/link/person | formula/lookup |
|-------------|--------|----------------------|---------------|----------|------|-------------------|----------------|
| eq          | is     | is                   | is            | is       | —    | —                 | —              |
| neq         | isNot  | isNot                | isNot         | —        | —    | —                 | —              |
| gt          | isGreater | —                 | —             | —        | —    | —                 | —              |
| gte         | isGreaterEqual | —            | —             | —        | —    | —                 | —              |
| lt          | isLess | —                    | —             | —        | —    | —                 | —              |
| lte         | isLessEqual | —               | —             | —        | —    | —                 | —              |
| includes    | —      | contains             | —             | —        | —    | —                 | —              |
| isnull      | isEmpty (all filterable types)                                                             |
| notnull     | isNotEmpty (all filterable types)                                                          |
| in/nin/contains/startswith | never pushed — local `applyFilters` only                                    |

lark-side constraints that shaped this: filter body is one `conjunction` + ≤50 conditions
(one nesting level exists but is unused here — atlas `or[][]` runs locally); values are string
arrays; dates take `["ExactDate", ms]` or relative words at day granularity (hence not pushed);
text rejects isGreaterEqual/isLessEqual; formula/lookup can't be conditions.

## capability (honest)

```
operators: all 13        — everything honored via pushdown-narrowed scan + applyFilters
sort: "multi"            — in-memory after residual filtering (byte order / numeric)
offset: true             — in-memory slice
count: "scan"            — scan-and-tally (filtered `total` semantics untested, so not trusted)
dateBucket: false        join: false          endpoints: []  (aggregate → 204)
enforcesDeclaredKeys: true   — only record_id is declared, lark enforces it
probeConcurrency: 2, cheapProbes: false — probes are full scans under a 20 rps app budget
```

## endpoints used

| purpose        | call                                                                  |
|----------------|-----------------------------------------------------------------------|
| auth           | `POST /open-apis/auth/v3/tenant_access_token/internal`                |
| list tables    | `GET  /open-apis/bitable/v1/apps/:app_token/tables` (page_size 100)   |
| list fields    | `GET  …/tables/:table_id/fields` (page_size 100, type + ui_type)      |
| rows / count   | `POST …/tables/:table_id/records/search` (page_size 500, 20 rps, `filter`, `field_names`, `total`) |

the older `GET …/records` (formula-string filter) is deprecated in favor of search; not used.

## what's built (all typechecks: `bun run check` clean; boots and serves)

- `src/lark-api.ts`: tenant-token cache (5 min slack, expired-code retry), enveloped
  request helper (`{code,msg,data}`), pagination loops for tables/fields/search, `total`.
- `src/field-map.ts`: the type table + read-side flattener above.
- `src/pushdown.ts`: atlas `and[]` → lark conditions per the operator table; or-blocks,
  overflow past 50, unknown fields, and unsafe types simply stay local.
- `src/connector.ts`: `LarkConnector extends AtlasConnector`; check (token mint + one table
  read), discover (tables + fields + samples + rowCount + link-field foreign keys + record_id
  pk), query (scan → applyFilters → projection, streaming when unordered and materialized for
  sort/offset), count (scan-tally), exactCount (`total`). the profiling methods and aggregate
  are left to the base class, which scans through query() and declines aggregate.
- `src/capability.ts`, `src/index.ts` (serve), `src/env.ts`, `src/byte-order.ts`.

verified live against two seeded bases on one process: check passes per tenant and fails on a
wrong secret or app_token, discovery returns each base's own tables, queries and probes answer,
bearer guard 401s, and upstream failures come back as wire-legal error envelopes.

## to take it live

1. create a custom app at open.larksuite.com (or open.feishu.cn) developer console; copy
   `app_id`/`app_secret`.
2. add scopes: `bitable:app:readonly` (simplest superset), publish/approve the app version.
3. create a base, note the `app_token` from its url (`…/base/<app_token>?table=…`), and add
   the app as a collaborator of that base.
4. `bun run start`, then send `credentials` (app id, app secret, app token) to `/check` and
   on to discovery and query.
5. live-test checklist (things the docs could not settle):
   - filtered search `total`: does it count matches? if yes, count can stop scanning when
     filters fully push.
   - text `is` semantics vs our byte-equality (case sensitivity, segment joins with mentions).
   - number `is` on formatted fields (currency/percent) — formatted vs raw value.
   - `field_names` interaction with filter fields not in the projection.
   - rate-limit behavior at 20 rps during probes (add a limiter if 99991400-style codes appear).
   - unicode table/field names end-to-end through atlas filters.
6. then point `atlas-conform` at it before registering with atlas.
