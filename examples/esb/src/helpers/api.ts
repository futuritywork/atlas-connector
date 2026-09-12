import { createHash } from "node:crypto";
import { badRequest, timeout, type Credentials } from "@futurity/atlas-connector";
import {
  ESB_APPLICATION_CODE,
  EsbCoreCredentials,
  EsbEnvelope,
  EsbFailureEnvelope,
  EsbMessageEnvelope,
} from "../schemas";
import type { EsbCoreObject } from "../types";

export const ESB_CORE_ORIGIN = "https://services.esb.co.id";

const HTTP_CODE = /^\d{3}$/;
const PERMISSION_CODES = new Set(["EC03100001", "EC03100002", "EC03100003"]); // also returned for validation failures
const COLLECTION_PERMISSION_DENIAL = /^access denied[.:]?\s|^unauthorized to access |did not have access to this resource/;

const INTERNAL_CODES = new Set([
  "invalid-token-response",
  "malformed-envelope",
  "malformed-response",
  "non-progressing-page",
]);

export type Deadline = {
  remainingMs(): number;
  check(): void;
};

export type WireResponse = {
  status: number;
  envelope?: EsbEnvelope;
};

export type TokenState = {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
};

export type TokenEntry = {
  token: TokenState | null;
  pending: Promise<TokenState> | null;
};

const tokenEntries = new Map<string, TokenEntry>();

export function isEsbApplicationCode(code: string): boolean {
  return ESB_APPLICATION_CODE.test(code);
}

export function sanitizeErrorCode(code: string): string {
  const known = isEsbApplicationCode(code) || HTTP_CODE.test(code) || INTERNAL_CODES.has(code);
  return known ? code : "unknown";
}

export function getFailureCode(envelope?: EsbEnvelope): string | null {
  const parsed = EsbFailureEnvelope.safeParse(envelope);
  return parsed.success ? parsed.data.code : null;
}

function getFailureMessage(response: WireResponse): string | null {
  const parsed = EsbMessageEnvelope.safeParse(response.envelope);
  return parsed.success ? parsed.data.message.trim().toLowerCase() : null;
}

export function isCollectionPermissionDenied(response: WireResponse): boolean {
  const message = getFailureMessage(response);
  if (message === "invalid token" || message === "unauthorized") return false;
  const code = getFailureCode(response.envelope);
  const deniedPhrasing = message !== null && COLLECTION_PERMISSION_DENIAL.test(message);
  const deniedByMessage = PERMISSION_CODES.has(code ?? "") && deniedPhrasing;
  const deniedByStatus = response.status === 403 && (code === null || code === "EC03100001");
  return deniedByMessage || deniedByStatus;
}

export function isCollectionUnauthorized(response: WireResponse): boolean {
  if (response.status === 401) return true;
  if (getFailureCode(response.envelope) !== "EC03100001") return false;
  const message = getFailureMessage(response);
  return message === "invalid token" || message === "unauthorized";
}

export function parseCredentials(input: Credentials): EsbCoreCredentials {
  const parsed = EsbCoreCredentials.safeParse(input);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.some((issue) => issue.path[0] === "username")) {
    throw badRequest("ESB Core username is required");
  }
  throw badRequest("ESB Core password is required");
}

export function tokenCacheKey(credentials: EsbCoreCredentials): string {
  return createHash("sha256")
    .update(ESB_CORE_ORIGIN)
    .update("\0")
    .update(credentials.username)
    .update("\0")
    .update(credentials.password)
    .digest("hex");
}

export function tokenEntryFor(key: string): TokenEntry {
  const now = Date.now();
  for (const [cachedKey, entry] of tokenEntries) {
    const spent = entry.token === null || entry.token.refreshExpiresAt <= now;
    if (entry.pending === null && spent) tokenEntries.delete(cachedKey);
  }
  const cached = tokenEntries.get(key);
  if (cached) return cached;
  const created: TokenEntry = { token: null, pending: null };
  tokenEntries.set(key, created);
  return created;
}

export function resetEsbCoreTokenCacheForTests(): void {
  tokenEntries.clear();
}

export function makeDeadline(timeoutMs: number): Deadline {
  const end = Date.now() + timeoutMs;
  const exhausted = () => timeout(`ESB Core upstream budget of ${timeoutMs}ms exhausted`);
  return {
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

export function isRequestTimeout(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "TimeoutError");
}

export function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function sanitizedResponseDetail(status: number): string {
  if (status === 401) return "credentials were rejected";
  if (status === 403) return "permission denied by ESB Core";
  if (status === 429) return "rate limited by ESB Core";
  if (status >= 500) return "ESB Core service unavailable";
  return "request rejected by ESB Core";
}

export async function readResponseBody(response: Response, signal: AbortSignal): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (isRequestTimeout(error, signal)) throw timeout("ESB Core request timed out");
    throw new Error(`ESB Core HTTP ${response.status}: response body could not be read`);
  }
}

export function parseResponseEnvelope(status: number, body: string): WireResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    if (isSuccessfulStatus(status)) throw new Error(`ESB Core HTTP ${status}: response was not valid JSON`);
    return { status };
  }
  const parsed = EsbEnvelope.safeParse(raw);
  if (parsed.success) return { status, envelope: parsed.data };
  if (isSuccessfulStatus(status)) throw new Error(`ESB Core HTTP ${status}: response envelope was malformed`);
  return { status };
}

export function describeCollection(object: EsbCoreObject, detail: string): string {
  return `${object.name} (${object.path}) ${detail}`;
}

export function describeMalformedRows(
  object: EsbCoreObject,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
): string {
  const fields = new Set(object.columns.map((column) => column.name));
  const field = issues.flatMap((issue) => issue.path).find((part) => typeof part === "string" && fields.has(part));
  return typeof field === "string" ? `returned a malformed ${field} field` : "collection rows were malformed";
}
