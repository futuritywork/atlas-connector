export const CONNECTOR_LIMITS = {
  docBytes: 64 * 1024,
  jsonAnswerBytes: 32 * 1024 * 1024,
  ndjsonLineBytes: 16 * 1024 * 1024,
  rowsPerBatch: 5000,
  heartbeatIntervalMs: 10_000, // Atlas's idle deadline is 3× this
} as const;
