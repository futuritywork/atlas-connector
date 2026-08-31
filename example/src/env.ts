// the connector's whole configuration surface; every value has a local-docker default so
// `bun run start` works with no env
export const CONFIG = {
  port: Number(process.env.CONNECTOR_PORT ?? 4100),
  databaseUrl:
    process.env.CONNECTOR_DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5434/brightline",
  schema: process.env.CONNECTOR_SCHEMA ?? "crm",
  // the protocol requires a bearer of at least 32 characters, so the dev default meets it too
  token:
    process.env.ATLAS_CONNECTOR_TOKEN ??
    "brightline-dev-token-0123456789abcdef",
  slug: "brightline",
};
