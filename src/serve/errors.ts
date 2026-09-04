import { z } from "zod";

// the wire error envelope: every non-2xx JSON body is exactly { error: { code, message } }
export type WireErrorBody = { error: { code: string; message: string } };

// 400 malformed body · 401 bad bearer · 404 unknown entity · 422 a legal Atlas request the
// capability document never advertised · 408 the request's own timeout · 500 anything else
const ConnectorStatusSchema = z.literal([400, 401, 404, 408, 422, 500]);
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

const CODE = {
  400: "bad_request",
  401: "unauthorized",
  404: "unknown_entity",
  408: "timeout",
  422: "unsupported",
  500: "internal",
} satisfies Record<ConnectorStatus, string>;

const ConnectorErrorCause = z.instanceof(Error).pipe(
  z.object({
    name: z.literal("ConnectorError"),
    status: ConnectorStatusSchema,
    message: z.string(),
  }),
);

export class ConnectorError extends Error {
  static fromCause(cause: unknown): ConnectorError | null {
    const parsed = ConnectorErrorCause.safeParse(cause);
    return parsed.success ? new ConnectorError(parsed.data.status, parsed.data.message) : null;
  }

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
