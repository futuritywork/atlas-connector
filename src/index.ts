// the sdk's public surface; the SqlConnector path lives under "./sql"

export * from "./wire/vocabulary";
export * from "./wire/limits";
export * from "./wire/schemas";
export * from "./wire/atlas-json";

export { AtlasConnector, type QueryChunk, SERVED_NOTHING, windowRows } from "./connector";
export { field, defineCatalog, fieldTypes, discoverFields, type Field, type Catalog } from "./catalog";

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
export { applyFilters, byteOrderCompare, decimalCompare } from "./kit/apply-filters";
export { assertKnownFields } from "./kit/assert-known-fields";
export {
  defineCapability,
  type EntityPushdown,
  type Pushdown,
  pushdownCapabilities,
  pushedOps,
} from "./kit/pushdown";
export {
  cardinalityFromValues,
  columnTally,
  linkFromValues,
  ORPHAN_SAMPLE_CAP,
} from "./kit/measure";
