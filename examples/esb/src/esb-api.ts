import { createHash } from "node:crypto";
import {
  badRequest,
  timeout,
  type Credentials,
  type SourceRow,
} from "@futurity/atlas-connector";
import {
  createCollectionRowsSchema,
  EsbCoreCredentialsSchema,
  EsbEnvelopeSchema,
  EsbFailureEnvelopeSchema,
  EsbMessageEnvelopeSchema,
  EsbPagedCollectionHeaderSchema,
  EsbPagedCollectionPageSchema,
  EsbSuccessEnvelopeSchema,
  EsbTokenResultSchema,
  type EsbCoreCredentials,
  type EsbEnvelope,
} from "./schemas";
import type { EsbCoreObject } from "./types";

export const ESB_CORE_ORIGIN = "https://services.esb.co.id";
const ESB_CORE_BASE_PATH = "/core";
const ACCESS_TTL_MS = 60 * 60 * 1_000;
const REFRESH_TTL_MS = 24 * 60 * 60 * 1_000;
const REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const AUTH_TIMEOUT_MS = 30_000;

export type Deadline = {
  readonly timeoutMs: number;
  remainingMs(): number;
  check(): void;
};

type WireResponse = {
  status: number;
  envelope?: EsbEnvelope;
};

type TokenState = {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
};

type TokenEntry = {
  token: TokenState | null;
  pending: Promise<TokenState> | null;
};

export type EsbCoreFailureKind = "permission" | "authentication";

type EsbCoreErrorOptions = {
  credentialFailure?: boolean;
  status?: number;
  applicationFailure?: boolean;
  failureKind?: EsbCoreFailureKind;
  requestToken?: TokenState;
};

export type EsbCorePage = {
  rows: SourceRow[];
  page?: number;
  limit?: number;
  hasNext: boolean;
};

const tokenEntries = new Map<string, TokenEntry>();
const ESB_APPLICATION_CODE = /^EC\d{8}$/;
const HTTP_CODE = /^\d{3}$/;
const INTERNAL_CODES = new Set([
  "invalid-token-response",
  "malformed-envelope",
  "malformed-response",
  "non-progressing-page",
  "unknown",
]);

function sanitizeCode(code: string): string {
  return ESB_APPLICATION_CODE.test(code) || HTTP_CODE.test(code) || INTERNAL_CODES.has(code) ? code : "unknown";
}

function failureCode(envelope?: EsbEnvelope): string | null {
  const parsed = EsbFailureEnvelopeSchema.safeParse(envelope);
  return parsed.success ? parsed.data.code : null;
}

function failureMessage(response: WireResponse): string | null {
  const parsed = EsbMessageEnvelopeSchema.safeParse(response.envelope);
  return parsed.success ? parsed.data.message.trim().toLowerCase() : null;
}

function collectionPermissionDenied(response: WireResponse): boolean {
  const message = failureMessage(response);
  if (message === "invalid token" || message === "unauthorized") return false;
  const code = failureCode(response.envelope);
  return (
    (code === "EC03100001" && message?.startsWith("unauthorized to access ") === true) ||
    (response.status === 403 && (code === null || code === "EC03100001"))
  );
}

function collectionUnauthorized(response: WireResponse): boolean {
  if (response.status === 401) return true;
  if (failureCode(response.envelope) !== "EC03100001") return false;
  const message = failureMessage(response);
  return message === "invalid token" || message === "unauthorized";
}

function credentialsFrom(input: Credentials): EsbCoreCredentials {
  const parsed = EsbCoreCredentialsSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.some((issue) => issue.path[0] === "username")) {
    throw badRequest("ESB Core username is required");
  }
  throw badRequest("ESB Core password is required");
}

function credentialKey(credentials: EsbCoreCredentials): string {
  return createHash("sha256")
    .update(ESB_CORE_ORIGIN)
    .update("\0")
    .update(credentials.username)
    .update("\0")
    .update(credentials.password)
    .digest("hex");
}

function entryFor(key: string): TokenEntry {
  const now = Date.now();
  for (const [cachedKey, entry] of tokenEntries) {
    if (entry.pending === null && (!entry.token || entry.token.refreshExpiresAt <= now)) tokenEntries.delete(cachedKey);
  }
  const cached = tokenEntries.get(key);
  if (cached) return cached;
  const created: TokenEntry = { token: null, pending: null };
  tokenEntries.set(key, created);
  return created;
}

export function makeDeadline(timeoutMs: number): Deadline {
  const end = Date.now() + timeoutMs;
  const exhausted = () => timeout(`ESB Core upstream budget of ${timeoutMs}ms exhausted`);
  return {
    timeoutMs,
    remainingMs() {
      const value = end - Date.now();
      if (value <= 0) throw exhausted();
      return value;
    },
    check() {
      if (Date.now() >= end) throw exhausted();
    },
  };
}

async function waitWithinDeadline<T>(promise: Promise<T>, deadline: Deadline): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(timeout(`ESB Core upstream budget of ${deadline.timeoutMs}ms exhausted`)),
          deadline.remainingMs(),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sanitizedDetail(status: number): string {
  if (status === 401) return "credentials were rejected";
  if (status === 403) return "permission denied by ESB Core";
  if (status === 429) return "rate limited by ESB Core";
  if (status >= 500) return "ESB Core service unavailable";
  return "request rejected by ESB Core";
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

async function readResponseBody(response: Response, signal: AbortSignal): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (signal.aborted || (error as { name?: unknown } | null)?.name === "TimeoutError") {
      throw timeout("ESB Core request timed out");
    }
    throw new Error(`ESB Core HTTP ${response.status}: response body could not be read`);
  }
}

function parseResponseEnvelope(status: number, body: string): WireResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    if (!isSuccessfulStatus(status)) return { status };
    throw new Error(`ESB Core HTTP ${status}: response was not valid JSON`);
  }
  const parsed = EsbEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    if (!isSuccessfulStatus(status)) return { status };
    throw new Error(`ESB Core HTTP ${status}: response envelope was malformed`);
  }
  return { status, envelope: parsed.data };
}

function collectionDetail(object: EsbCoreObject, detail: string): string {
  return `${object.name} (${object.path}) ${detail}`;
}

function malformedRowsDetail(
  object: EsbCoreObject,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
): string {
  const fields = new Set(object.columns.map((column) => column.name));
  const field = issues.flatMap((issue) => issue.path).find((part) => typeof part === "string" && fields.has(part));
  return typeof field === "string" ? `returned a malformed ${field} field` : "collection rows were malformed";
}

export class EsbCoreError extends Error {
  readonly code: string;

  constructor(
    code: string,
    detail: string,
    readonly credentialFailure = false,
    readonly status?: number,
    readonly applicationFailure = false,
    readonly failureKind?: EsbCoreFailureKind,
  ) {
    const cleanCode = sanitizeCode(code);
    super(`esb-core: ${cleanCode}: ${detail}`);
    this.name = "EsbCoreError";
    this.code = cleanCode;
  }
}

export class EsbCoreApi {
  private readonly credentials: EsbCoreCredentials;
  private readonly entry: TokenEntry;

  constructor(input: Credentials) {
    this.credentials = credentialsFrom(input);
    this.entry = entryFor(credentialKey(this.credentials));
  }

  private publicCode(code: string, requestToken?: TokenState): string {
    const sanitized = sanitizeCode(code);
    if (!ESB_APPLICATION_CODE.test(sanitized)) return sanitized;
    const cached = this.entry.token;
    const tokenSecrets = [cached, requestToken].flatMap((token) =>
      token ? [token.accessToken, token.refreshToken] : [],
    );
    const secrets = [this.credentials.username, this.credentials.password, ...tokenSecrets];
    return secrets.some((secret) => secret.includes(sanitized) || sanitized.includes(secret)) ? "unknown" : sanitized;
  }

  private error(code: string, detail: string, options: EsbCoreErrorOptions = {}): EsbCoreError {
    return new EsbCoreError(
      this.publicCode(code, options.requestToken),
      detail,
      options.credentialFailure ?? false,
      options.status,
      options.applicationFailure ?? false,
      options.failureKind,
    );
  }

  private async fetchEnvelope(path: string, deadline: Deadline, init: RequestInit): Promise<WireResponse> {
    deadline.check();
    const signal = AbortSignal.timeout(Math.max(1, deadline.remainingMs()));
    let response: Response;
    try {
      response = await fetch(`${ESB_CORE_ORIGIN}${ESB_CORE_BASE_PATH}${path}`, {
        ...init,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (signal.aborted || (error as { name?: unknown } | null)?.name === "TimeoutError") {
        throw timeout("ESB Core request timed out");
      }
      throw new Error("ESB Core network request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error(`ESB Core HTTP ${response.status}: redirects are not allowed`);
    }
    const body = await readResponseBody(response, signal);
    return parseResponseEnvelope(response.status, body);
  }

  private parseToken(
    response: WireResponse,
    now: number,
    endpoint: "login" | "refresh",
    requestToken?: TokenState,
  ): TokenState {
    const code = failureCode(response.envelope);
    if (!isSuccessfulStatus(response.status)) {
      const credentialFailure =
        response.status === 401 ||
        response.status === 403 ||
        code === "EC03100001" ||
        (endpoint === "login" && code === "EC03100032");
      throw this.error(
        code ?? String(response.status),
        credentialFailure ? "credentials were rejected" : sanitizedDetail(response.status),
        { credentialFailure, status: response.status, requestToken },
      );
    }
    const success = EsbSuccessEnvelopeSchema.safeParse(response.envelope);
    if (!success.success) {
      if (code !== null) {
        const credentialFailure = code === "EC03100001" || (endpoint === "login" && code === "EC03100032");
        throw this.error(code, credentialFailure ? "credentials were rejected" : sanitizedDetail(response.status), {
          credentialFailure,
          status: response.status,
          applicationFailure: true,
          requestToken,
        });
      }
      throw this.error("malformed-envelope", "token response envelope was malformed", {
        status: response.status,
        requestToken,
      });
    }
    const result = EsbTokenResultSchema.safeParse(success.data.result);
    if (!result.success) {
      throw this.error("invalid-token-response", "token response was malformed", {
        status: response.status,
        requestToken,
      });
    }
    return {
      accessToken: result.data.accessToken,
      accessExpiresAt: now + ACCESS_TTL_MS,
      refreshToken: result.data.refreshToken,
      refreshExpiresAt: now + REFRESH_TTL_MS,
    };
  }

  private async login(deadline: Deadline): Promise<TokenState> {
    const now = Date.now();
    const response = await this.fetchEnvelope("/auth/login", deadline, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(this.credentials),
    });
    return this.parseToken(response, now, "login");
  }

  private async refresh(deadline: Deadline, tokenState: TokenState): Promise<TokenState> {
    const now = Date.now();
    const response = await this.fetchEnvelope("/auth/refresh", deadline, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${tokenState.refreshToken}` },
    });
    return this.parseToken(response, now, "refresh", tokenState);
  }

  private async mintFrom(current: TokenState | null, deadline: Deadline): Promise<TokenState> {
    if (current && current.refreshExpiresAt - Date.now() > REFRESH_MARGIN_MS) {
      try {
        return await this.refresh(deadline, current);
      } catch (error) {
        if (error instanceof EsbCoreError && error.credentialFailure) return await this.login(deadline);
        throw error;
      }
    }
    return await this.login(deadline);
  }

  private usable(tokenState: TokenState | null, rejectedAccessToken?: string): tokenState is TokenState {
    return (
      tokenState !== null &&
      tokenState.accessExpiresAt - Date.now() > REFRESH_MARGIN_MS &&
      (rejectedAccessToken === undefined || tokenState.accessToken !== rejectedAccessToken)
    );
  }

  private async token(deadline: Deadline, rejectedAccessToken?: string): Promise<TokenState> {
    if (this.usable(this.entry.token, rejectedAccessToken)) return this.entry.token;
    if (!this.entry.pending) {
      const authDeadline = makeDeadline(AUTH_TIMEOUT_MS);
      const pending = this.mintFrom(this.entry.token, authDeadline);
      this.entry.pending = pending;
      pending.then(
        (tokenState) => {
          this.entry.token = tokenState;
          if (this.entry.pending === pending) this.entry.pending = null;
        },
        () => {
          if (this.entry.pending === pending) this.entry.pending = null;
        },
      );
    }
    return await waitWithinDeadline(this.entry.pending, deadline);
  }

  private invalidate(rejectedAccessToken: string): void {
    if (this.entry.token?.accessToken === rejectedAccessToken) {
      this.entry.token = { ...this.entry.token, accessExpiresAt: 0 };
    }
  }

  async authenticate(deadline: Deadline): Promise<void> {
    await this.token(deadline);
  }

  private async requestCollection(
    object: EsbCoreObject,
    page: number,
    limit: number,
    deadline: Deadline,
    tokenState: TokenState,
  ): Promise<WireResponse> {
    const search = new URLSearchParams();
    if (object.mode === "paged") {
      search.set("page", String(page));
      search.set("limit", String(limit));
    }
    const suffix = search.size > 0 ? `?${search}` : "";
    return await this.fetchEnvelope(`${object.path}${suffix}`, deadline, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenState.accessToken}`,
      },
    });
  }

  async collection(
    object: EsbCoreObject,
    page: number,
    limit: number,
    deadline: Deadline,
    fields?: readonly string[],
  ): Promise<EsbCorePage> {
    let rejectedAccessToken: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tokenState = await this.token(deadline, rejectedAccessToken);
      const response = await this.requestCollection(object, page, limit, deadline, tokenState);
      if (collectionPermissionDenied(response)) {
        throw this.error(failureCode(response.envelope) ?? String(response.status), "permission denied by ESB Core", {
          status: response.status,
          applicationFailure: isSuccessfulStatus(response.status),
          failureKind: "permission",
          requestToken: tokenState,
        });
      }
      if (!collectionUnauthorized(response)) {
        return this.decodeCollection(object, page, response, tokenState, fields);
      }
      rejectedAccessToken = tokenState.accessToken;
      this.invalidate(tokenState.accessToken);
      if (attempt === 1) {
        throw this.error(
          failureCode(response.envelope) ?? String(response.status),
          "authentication remained invalid after token refresh",
          { status: response.status, failureKind: "authentication", requestToken: tokenState },
        );
      }
    }
    throw new Error("ESB Core collection authorization retry exhausted");
  }

  private decodeCollection(
    object: EsbCoreObject,
    page: number,
    response: WireResponse,
    requestToken: TokenState,
    fields?: readonly string[],
  ): EsbCorePage {
    const code = failureCode(response.envelope);
    if (!isSuccessfulStatus(response.status)) {
      throw this.error(code ?? String(response.status), sanitizedDetail(response.status), {
        status: response.status,
        applicationFailure: code !== null,
        requestToken,
      });
    }
    const success = EsbSuccessEnvelopeSchema.safeParse(response.envelope);
    if (!success.success) {
      if (code !== null) {
        throw this.error(code, sanitizedDetail(response.status), {
          status: response.status,
          applicationFailure: true,
          requestToken,
        });
      }
      throw this.error("malformed-envelope", collectionDetail(object, "collection response envelope was malformed"), {
        status: response.status,
      });
    }

    const result = success.data.result;
    if (object.mode === "direct") {
      const parsed = createCollectionRowsSchema(object, fields).safeParse(result);
      if (!parsed.success) {
        throw this.error("malformed-response", collectionDetail(object, malformedRowsDetail(object, parsed.error.issues)), {
          status: response.status,
        });
      }
      return { rows: parsed.data, hasNext: false };
    }

    const returnedPage = EsbPagedCollectionPageSchema.safeParse(result);
    if (!returnedPage.success || returnedPage.data.page !== page) {
      throw this.error("non-progressing-page", collectionDetail(object, "returned a different or malformed page"), {
        status: response.status,
      });
    }
    const header = EsbPagedCollectionHeaderSchema.safeParse(result);
    if (!header.success) {
      throw this.error("malformed-response", collectionDetail(object, "collection response was malformed"), {
        status: response.status,
      });
    }

    const parsed = createCollectionRowsSchema(object, fields).safeParse(header.data.data);
    if (!parsed.success) {
      throw this.error("malformed-response", collectionDetail(object, malformedRowsDetail(object, parsed.error.issues)), {
        status: response.status,
      });
    }
    return {
      rows: parsed.data,
      page: header.data.page,
      limit: header.data.limit,
      hasNext: header.data.next.length > 0,
    };
  }
}

export function resetEsbCoreTokenCacheForTests(): void {
  tokenEntries.clear();
}
