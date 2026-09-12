/** the envelope every non-2xx body carries, and nothing else. */
export type WireErrorBody = { error: { code: string; message: string } };

const CODE = {
  400: "bad_request",
  401: "unauthorized",
  404: "unknown_entity",
  408: "timeout",
  422: "unsupported", // a legal Atlas request the capability doc never advertised
  500: "internal",
};

export type ConnectorStatus = keyof typeof CODE;

/** thrown from any connector method; serve answers with this status and its wire code. */
export class ConnectorError extends Error {
  constructor(
    readonly status: ConnectorStatus,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }

  body(): WireErrorBody {
    return { error: { code: CODE[this.status], message: this.message } };
  }

  // a second sdk copy in the module graph defeats instanceof, so match on name plus status
  static fromCause(cause: unknown): ConnectorError | null {
    if (cause instanceof ConnectorError) return cause;
    if (!(cause instanceof Error) || cause.name !== "ConnectorError" || !("status" in cause)) return null;
    const { status } = cause;
    if (typeof status !== "number" || !(status in CODE)) return null;
    return new ConnectorError(status as ConnectorStatus, cause.message);
  }
}

export const badRequest = (message: string) => new ConnectorError(400, message);
export const unauthorized = (message: string) => new ConnectorError(401, message);
export const unknownEntity = (message: string) => new ConnectorError(404, message);
export const timeout = (message: string) => new ConnectorError(408, message);
export const unsupported = (message: string) => new ConnectorError(422, message);
