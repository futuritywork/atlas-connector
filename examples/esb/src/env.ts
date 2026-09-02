function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

// ESB Core credentials arrive on each request and are never environment configuration.
export const CONFIG = {
  port: Number(process.env.PORT ?? process.env.CONNECTOR_PORT ?? 4100),
  bearerToken: required("ATLAS_CONNECTOR_TOKEN"),
} as const;
