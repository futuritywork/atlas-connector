function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

// the whole server-side configuration: a port and the bearer atlas presents.
// lark credentials are never here; they arrive on each request from the tenant.
export const CONFIG = {
  port: Number(process.env.PORT ?? process.env.CONNECTOR_PORT ?? 4100),
  bearerToken: required("ATLAS_CONNECTOR_TOKEN"),
} as const;
