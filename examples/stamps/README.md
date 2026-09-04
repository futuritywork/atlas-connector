# Stamps Atlas connector

Read-only Atlas connector for Stamps API v4. It exposes two tables:

- `stores`: the merchant's stores from `GET /api/v4/stores/`;
- `rewards`: merchant rewards from cursor-paginated `GET /api/v4/rewards/`.

The connector deliberately excludes members, profiles, vouchers, activities,
redemptions, and transactions. Those endpoints require a person or transaction
lookup and cannot support Atlas's unfiltered discovery and profiling scans.

## Credentials

Atlas sends Stamps credentials on every request. They are not environment
variables and the connector does not persist them.

| Field | Required | Value |
| --- | --- | --- |
| `merchantToken` | yes | Stamps CRM -> **Settings -> API Settings -> Merchant -> Token** |
| `baseUrl` | no | `https://staging-crm2.stamps.id` (default) or `https://staging-crm.stamps.id` |

Only the two documented HTTPS staging origins are accepted. Paths, query
strings, embedded credentials, ports, and arbitrary hosts are rejected.

The deployed connector itself requires one host secret:

```env
ATLAS_CONNECTOR_TOKEN=<random value of at least 32 characters>
```

This is the bearer token Atlas uses to call the connector. It is not a Stamps
credential. Generate it with `openssl rand -hex 24` and store it in the hosting
platform's protected secret store.

## Local setup

```sh
cp .env.example .env
bun install
bun run check
bun run start
```

The standalone example listens on `CONNECTOR_PORT` (default `4100`). Its
capability document is public:

```sh
curl http://localhost:4100/.well-known/futurity/atlas.json
```

For an authenticated check, send the same `ATLAS_CONNECTOR_TOKEN` as the
connector bearer and place the Stamps token in the request-scoped credentials:

```sh
curl -X POST http://localhost:4100/check \
  -H "authorization: Bearer $ATLAS_CONNECTOR_TOKEN" \
  -H "content-type: application/json" \
  --data-binary @check-request.json
```

Keep `check-request.json` outside the repository and delete it after the test:

```json
{
  "credentials": {
    "merchantToken": "<Stamps staging merchant token>"
  },
  "timeoutMs": 10000
}
```

The shared hosted process mounts this connector at
`https://atlas.futurity.work/stamps`. Upstream Stamps credentials remain
request-scoped; Railway needs only `ATLAS_CONNECTOR_TOKEN`.

## Query behavior

All Stamps rows are validated with Zod at the HTTP boundary. Array and object
properties such as store photos, reward membership levels, and reward metadata
are intentionally omitted because Atlas rows contain scalar values only.

The connector fetches Stamps pages in source order, applies Atlas filters in
memory, and projects only the requested fields. Sorting, offsets, joins, and
aggregates are not advertised and are rejected if sent. Counts and profiling
scan the same rows as queries.

See the [Stamps API v4 documentation](https://staging-crm2.stamps.id/api/v4/docs)
and [OpenAPI document](https://staging-crm2.stamps.id/api/v4/openapi.json).
