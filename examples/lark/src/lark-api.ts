// thin client for the lark open platform: tenant-token auth plus the bitable endpoints this connector reads; one instance per request

import { createHash } from "node:crypto";
import {
  badRequest,
  ConnectorError,
  type Credentials,
  timeout as timeoutError,
  unknownEntity,
} from "@futurity/atlas-connector";

// feishu.cn bases change this one line
const DOMAIN = "https://open.larksuite.com";

const TOKEN_SLACK_MS = 5 * 60 * 1000;
// lark app_access_token invalid / tenant token expired: refetch once and retry
const TOKEN_EXPIRED_CODES = new Set([99991661, 99991663, 99991664, 99991668]);

const REQUIRED_KEYS = ["appId", "appSecret", "appToken"] as const;

type LarkCredentials = {
  appId: string;
  appSecret: string;
  appToken: string;
};

type TokenAnswer = { code: number; msg: string; tenant_access_token?: string; expire?: number };

export type LarkTable = { table_id: string; name: string };

// only the slice this connector reads; link fields carry the target table in property.table_id
export type LarkField = {
  field_name: string;
  type: number;
  ui_type?: string;
  property?: { table_id?: string } | null;
};

export type LarkRecord = {
  record_id: string;
  fields: Record<string, unknown>;
};

export type LarkCondition = { field_name: string; operator: string; value?: string[] };

type SearchPage = {
  items?: LarkRecord[];
  has_more: boolean;
  page_token?: string;
  total?: number;
};

// lark's per-request deadline: every upstream call aborts at the wire request's own budget
export type Deadline = { remainingMs(): number; check(): void };

// tokens belong to the app, not the base, so tenants sharing an app share one mint
// keyed by digest: a secret must not sit in a map key
const tokens = new Map<string, { value: string; expiresAt: number }>();

function digest(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function larkCredentials(credentials: Credentials): LarkCredentials {
  const missing = REQUIRED_KEYS.filter((key) => !credentials[key]);
  if (missing.length > 0) throw badRequest(`missing credentials: ${missing.join(", ")}`);
  return { appId: credentials.appId, appSecret: credentials.appSecret, appToken: credentials.appToken };
}

export function makeDeadline(timeoutMs: number): Deadline {
  const end = Date.now() + timeoutMs;
  return {
    remainingMs: () => Math.max(1, end - Date.now()),
    check: () => {
      if (Date.now() >= end) throw timeoutError(`upstream budget of ${timeoutMs}ms exhausted`);
    },
  };
}

export class LarkClient {
  // digest of the whole set, so a cache entry never answers another set
  readonly cacheKey: string;
  private readonly tokenKey: string;

  constructor(private readonly credentials: LarkCredentials) {
    const { appId, appSecret, appToken } = credentials;
    this.cacheKey = digest([appId, appSecret, appToken]);
    this.tokenKey = digest([appId, appSecret]);
  }

  // POST /auth/v3/tenant_access_token/internal → { tenant_access_token, expire } (expire ≈ 7200s)
  private async tenantToken(deadline: Deadline): Promise<string> {
    const key = this.tokenKey;
    const cached = tokens.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    deadline.check();
    const res = await fetch(`${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: this.credentials.appId, app_secret: this.credentials.appSecret }),
      signal: AbortSignal.timeout(deadline.remainingMs()),
    });
    const body = (await res.json()) as TokenAnswer;
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`lark tenant_access_token failed: code=${body.code} ${body.msg}`);
    }

    tokens.set(key, {
      value: body.tenant_access_token,
      expiresAt: Date.now() + (body.expire ?? 7200) * 1000 - TOKEN_SLACK_MS,
    });
    return body.tenant_access_token;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    deadline: Deadline,
    opts: { query?: Record<string, string>; body?: unknown } = {},
    retried = false,
  ): Promise<T> {
    const token = await this.tenantToken(deadline);
    deadline.check();
    const url = new URL(`${DOMAIN}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(deadline.remainingMs()),
    });

    const envelope = (await res.json()) as { code: number; msg: string; data?: T };
    if (envelope.code !== 0) {
      if (TOKEN_EXPIRED_CODES.has(envelope.code) && !retried) {
        tokens.delete(this.tokenKey);
        return await this.request(method, path, deadline, opts, true);
      }
      if (res.status === 404 || envelope.code === 91402) {
        throw unknownEntity(`lark: ${envelope.msg} (code=${envelope.code})`);
      }
      throw new Error(`lark ${path}: code=${envelope.code} ${envelope.msg}`);
    }
    return envelope.data as T;
  }

  private tablesPath(): string {
    return `/open-apis/bitable/v1/apps/${this.credentials.appToken}/tables`;
  }

  // the mint proves app_id/app_secret, the read proves app_token
  // failures leave as plain Error: /check shows the message to the tenant
  async checkAccess(deadline: Deadline): Promise<void> {
    try {
      await this.request<{ items?: LarkTable[] }>("GET", this.tablesPath(), deadline, {
        query: { page_size: "1" },
      });
    } catch (error) {
      // lark answers 91402 NOTEXIST both for a token that names no base and for a base the app was never added to
      if (error instanceof ConnectorError && error.status === 404) {
        throw new Error(
          `Lark has no base ${this.credentials.appToken} this app can open: check the token, and that the app was added to the base as a collaborator (${error.message})`,
        );
      }
      throw error instanceof ConnectorError ? new Error(error.message) : error;
    }
  }

  // GET pagination: follow page_token until has_more clears; metadata pages cap at 100
  private async listAll<T>(path: string, deadline: Deadline): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    do {
      deadline.check();
      const page = await this.request<{ items?: T[]; has_more: boolean; page_token?: string }>("GET", path, deadline, {
        query: { page_size: "100", ...(pageToken ? { page_token: pageToken } : {}) },
      });
      items.push(...(page.items ?? []));
      pageToken = page.has_more ? page.page_token : undefined;
    } while (pageToken);
    return items;
  }

  async listTables(deadline: Deadline): Promise<LarkTable[]> {
    return await this.listAll<LarkTable>(this.tablesPath(), deadline);
  }

  async listFields(tableId: string, deadline: Deadline): Promise<LarkField[]> {
    return await this.listAll<LarkField>(`${this.tablesPath()}/${tableId}/fields`, deadline);
  }

  // POST .../records/search — one page; conditions are AND-conjoined; page_size max 500
  async searchPage(
    tableId: string,
    deadline: Deadline,
    opts: {
      fieldNames?: string[];
      conditions?: LarkCondition[];
      pageToken?: string;
      pageSize?: number;
    } = {},
  ): Promise<SearchPage> {
    deadline.check();
    const body: Record<string, unknown> = { automatic_fields: false };
    if (opts.fieldNames && opts.fieldNames.length > 0) body.field_names = opts.fieldNames;
    if (opts.conditions && opts.conditions.length > 0) {
      body.filter = { conjunction: "and", conditions: opts.conditions };
    }
    return await this.request<SearchPage>("POST", `${this.tablesPath()}/${tableId}/records/search`, deadline, {
      query: {
        page_size: String(opts.pageSize ?? 500),
        ...(opts.pageToken ? { page_token: opts.pageToken } : {}),
      },
      body,
    });
  }

  // full scan of a table under the given pushdown; caps nothing — callers own limits
  async *searchAll(
    tableId: string,
    deadline: Deadline,
    opts: { fieldNames?: string[]; conditions?: LarkCondition[] } = {},
  ): AsyncIterable<LarkRecord[]> {
    let pageToken: string | undefined;
    do {
      const page = await this.searchPage(tableId, deadline, { ...opts, pageToken });
      if (page.items && page.items.length > 0) yield page.items;
      pageToken = page.has_more ? page.page_token : undefined;
    } while (pageToken);
  }

  // exact table size: an unfiltered search page carries the table's total
  async recordTotal(tableId: string, deadline: Deadline): Promise<number | null> {
    const page = await this.searchPage(tableId, deadline, { pageSize: 1 });
    return page.total ?? null;
  }
}
