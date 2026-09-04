// the wire error envelope: every non-2xx JSON body is exactly { error: { code, message } }
export type WireErrorBody = { error: { code: string; message: string } };

// 400 malformed body · 401 bad bearer · 404 unknown entity · 422 a legal Atlas request the
// capability document never advertised · 408 the request's own timeout · 500 anything else
export type ConnectorStatus = 400 | 401 | 404 | 408 | 422 | 500;

const CODE: Record<ConnectorStatus, string> = {
  400: "bad_request",
  401: "unauthorized",
  404: "unknown_entity",
  408: "timeout",
  422: "unsupported",
  500: "internal",
};

const CONNECTOR_ERROR_BRAND = Symbol.for("@futurity/atlas-connector/ConnectorError");

export class ConnectorError extends Error {
  constructor(
    readonly status: ConnectorStatus,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
    Object.defineProperty(this, CONNECTOR_ERROR_BRAND, { value: true });
  }

  body(): WireErrorBody {
    return { error: { code: CODE[this.status], message: this.message } };
  }
}

export function isConnectorError(error: unknown): error is ConnectorError {
  if (error instanceof ConnectorError) return true;
  if (typeof error !== "object" || error === null) return false;
  return (error as Record<symbol, unknown>)[CONNECTOR_ERROR_BRAND] === true;
}

export const badRequest = (message: string) => new ConnectorError(400, message);
export const unauthorized = (message: string) => new ConnectorError(401, message);
export const unknownEntity = (message: string) => new ConnectorError(404, message);
export const unsupported = (message: string) => new ConnectorError(422, message);
export const timeout = (message: string) => new ConnectorError(408, message);
