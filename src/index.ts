// root barrel — the SDK's public surface (SDK-SPEC §3.1). the SqlConnector path lives under "./sql".

export * from "./wire/vocabulary";
export * from "./wire/limits";
export * from "./wire/schemas";
export * from "./wire/atlas-json";

export { AtlasConnector } from "./connector";

export { createApp, serve, type ServeOptions } from "./serve/serve";
export {
  badRequest,
  ConnectorError,
  type ConnectorStatus,
  timeout,
  unauthorized,
  unknownEntity,
  unsupported,
  type WireErrorBody,
} from "./serve/errors";
export { parseBody, withTimeout } from "./serve/http";
export { bearerGuard } from "./serve/auth";
export { ndjsonStream } from "./serve/stream";

// the kit a rest/erp author reaches for when they don't extend SqlConnector
export { applyFilters } from "./kit/apply-filters";
export {
  columnCountsFromValues,
  DUP_SAMPLE_CAP,
  grainFromValues,
  linkFromValues,
  NEAR_UNIQUE_MIN_SHARE,
  ORPHAN_SAMPLE_CAP,
} from "./kit/probe-math";
