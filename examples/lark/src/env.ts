function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export const CONFIG = {
  port: Number(process.env.CONNECTOR_PORT ?? 4100),
  bearerToken: required("ATLAS_CONNECTOR_TOKEN"),
  appId: required("LARK_APP_ID"),
  appSecret: required("LARK_APP_SECRET"),
  appToken: required("LARK_APP_TOKEN"),
  domain: process.env.LARK_DOMAIN ?? "https://open.larksuite.com",
} as const;
