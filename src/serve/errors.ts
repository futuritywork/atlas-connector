// the wire error envelope: every non-2xx JSON body is exactly { error: { code, message } }
export type WireErrorBody = { error: { code: string; message: string } };

// 400 malformed body · 401 bad bearer · 404 unknown entity · 422 a legal Atlas request the
// capability document never advertised · 408 the request's own timeout · 500 anything else
const CODE = {
  400: "bad_request",
  401: "unauthorized",
  404: "unknown_entity",
  408: "timeout",
  422: "unsupported",
  500: "internal",
};

export type ConnectorStatus = keyof typeof CODE;

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
}

export const badRequest = (message: string) => new ConnectorError(400, message);
export const unauthorized = (message: string) => new ConnectorError(401, message);
export const unknownEntity = (message: string) => new ConnectorError(404, message);
export const unsupported = (message: string) => new ConnectorError(422, message);
export const timeout = (message: string) => new ConnectorError(408, message);
