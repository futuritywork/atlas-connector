import {
  timeout,
  type Credentials,
  type SourceRow,
} from "@futurity/atlas-connector";
import {
  describeCollection,
  describeMalformedRows,
  ESB_CORE_ORIGIN,
  getFailureCode,
  isCollectionPermissionDenied,
  isCollectionUnauthorized,
  isEsbApplicationCode,
  isRequestTimeout,
  isSuccessfulStatus,
  makeDeadline,
  parseCredentials,
  parseResponseEnvelope,
  readResponseBody,
  resetEsbCoreTokenCacheForTests,
  sanitizedResponseDetail,
  sanitizeErrorCode,
  tokenCacheKey,
  tokenEntryFor,
  waitWithinDeadline,
  type Deadline,
  type TokenEntry,
  type TokenState,
  type WireResponse,
} from "./helpers/api";
import {
  EsbCollectionRows,
  EsbPagedCollectionHeader,
  EsbPagedCollectionPage,
  EsbSuccessEnvelope,
  EsbTokenResult,
} from "./schemas";
import type { EsbCoreCredentials } from "./schemas";
import type { EsbCoreObject } from "./types";

export { ESB_CORE_ORIGIN, makeDeadline, resetEsbCoreTokenCacheForTests };
export type { Deadline };

const ESB_CORE_BASE_PATH = "/core";
const ACCESS_TTL_MS = 60 * 60 * 1_000;
const REFRESH_TTL_MS = 24 * 60 * 60 * 1_000;
const REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const AUTH_TIMEOUT_MS = 30_000;

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
    const cleanCode = sanitizeErrorCode(code);
    super(`esb-core: ${cleanCode}: ${detail}`);
    this.name = "EsbCoreError";
    this.code = cleanCode;
  }
}

export class EsbCoreApi {
  private readonly credentials: EsbCoreCredentials;
  private readonly entry: TokenEntry;

  constructor(input: Credentials) {
    this.credentials = parseCredentials(input);
    this.entry = tokenEntryFor(tokenCacheKey(this.credentials));
  }

  private publicCode(code: string, requestToken?: TokenState): string {
    const sanitized = sanitizeErrorCode(code);
    if (!isEsbApplicationCode(sanitized)) return sanitized;
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
      if (isRequestTimeout(error, signal)) throw timeout("ESB Core request timed out");
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
    const code = getFailureCode(response.envelope);
    const tokenFailure = (applicationFailure: boolean): EsbCoreError => {
      const credentialFailure =
        response.status === 401 ||
        response.status === 403 ||
        code === "EC03100001" ||
        (endpoint === "login" && code === "EC03100032");
      return this.error(
        code ?? String(response.status),
        credentialFailure ? "credentials were rejected" : sanitizedResponseDetail(response.status),
        { credentialFailure, status: response.status, applicationFailure, requestToken },
      );
    };
    if (!isSuccessfulStatus(response.status)) throw tokenFailure(false);

    const success = EsbSuccessEnvelope.safeParse(response.envelope);
    if (!success.success) {
      if (code !== null) throw tokenFailure(true);
      throw this.error("malformed-envelope", "token response envelope was malformed", {
        status: response.status,
        requestToken,
      });
    }
    const result = EsbTokenResult.safeParse(success.data.result);
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
      if (isCollectionPermissionDenied(response)) {
        throw this.error(getFailureCode(response.envelope) ?? String(response.status), "permission denied by ESB Core", {
          status: response.status,
          applicationFailure: isSuccessfulStatus(response.status),
          failureKind: "permission",
          requestToken: tokenState,
        });
      }
      if (!isCollectionUnauthorized(response)) {
        return this.decodeCollection(object, page, response, tokenState, fields);
      }
      rejectedAccessToken = tokenState.accessToken;
      this.invalidate(tokenState.accessToken);
      if (attempt === 1) {
        throw this.error(
          getFailureCode(response.envelope) ?? String(response.status),
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
    const code = getFailureCode(response.envelope);
    if (!isSuccessfulStatus(response.status)) {
      throw this.error(code ?? String(response.status), sanitizedResponseDetail(response.status), {
        status: response.status,
        applicationFailure: code !== null,
        requestToken,
      });
    }
    const success = EsbSuccessEnvelope.safeParse(response.envelope);
    if (!success.success) {
      if (code !== null) {
        throw this.error(code, sanitizedResponseDetail(response.status), {
          status: response.status,
          applicationFailure: true,
          requestToken,
        });
      }
      throw this.error("malformed-envelope", describeCollection(object, "collection response envelope was malformed"), {
        status: response.status,
      });
    }

    const result = success.data.result;
    if (object.mode === "direct") {
      const parsed = EsbCollectionRows(object, fields).safeParse(result);
      if (!parsed.success) {
        throw this.error("malformed-response", describeCollection(object, describeMalformedRows(object, parsed.error.issues)), {
          status: response.status,
        });
      }
      return { rows: parsed.data, hasNext: false };
    }

    const returnedPage = EsbPagedCollectionPage.safeParse(result);
    if (!returnedPage.success || returnedPage.data.page !== page) {
      throw this.error("non-progressing-page", describeCollection(object, "returned a different or malformed page"), {
        status: response.status,
      });
    }
    const header = EsbPagedCollectionHeader.safeParse(result);
    if (!header.success) {
      throw this.error("malformed-response", describeCollection(object, "collection response was malformed"), {
        status: response.status,
      });
    }

    const parsed = EsbCollectionRows(object, fields).safeParse(header.data.data);
    if (!parsed.success) {
      throw this.error("malformed-response", describeCollection(object, describeMalformedRows(object, parsed.error.issues)), {
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
