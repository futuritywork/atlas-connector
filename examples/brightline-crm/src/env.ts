// no database url: that is the tenant's credential, on every request and never stored
export const CONFIG = {
  port: Number(process.env.CONNECTOR_PORT ?? 4100),
  schema: process.env.CONNECTOR_SCHEMA ?? "crm",
  // the protocol requires a bearer of at least 32 characters, so the dev default meets it too
  token:
    process.env.ATLAS_CONNECTOR_TOKEN ??
    "brightline-dev-token-0123456789abcdef",
  slug: "brightline",
};
