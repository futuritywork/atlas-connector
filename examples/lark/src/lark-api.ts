import { createHash } from "node:crypto";
import {
  badRequest,
  ConnectorError,
  type Credentials,
  timeout as timeoutError,
  unknownEntity,
} from "@futurity/atlas-connector";

const DOMAIN = "https://open.larksuite.com"; // feishu.cn bases change this line

const TOKEN_SLACK_MS = 5 * 60 * 1000;
const TOKEN_EXPIRED_CODES = new Set([99991661, 99991663, 99991664, 99991668]); // tenant token expired or invalid
const RATE_LIMITED_CODE = 1254290; // app-level qps, TooManyRequest
const RATE_LIMIT_BACKOFF_MS = 600;
const RECORD_NOT_FOUND_CODE = 1254043;
const NOT_EXIST_CODE = 91402; // an unknown app_token, and a base the app was never added to

export const MAX_PAGE_SIZE = 500; // bitable's ceiling on one search page

const REQUIRED_KEYS = ["appId", "appSecret", "appToken"] as const;

type LarkCredentials = {
  appId: string;
  appSecret: string;
  appToken: string;
};

type TokenAnswer = { code: number; msg: string; tenant_access_token?: string; expire?: number };

export type LarkTable = { table_id: string; name: string };

export type LarkField = {
  field_name: string;
  type: number;
  ui_type?: string;
  property?: { table_id?: string; options?: { name?: string }[] } | null; // table_id names a link field's target
};

export type LarkRecord = {
  record_id: string;
  fields: Record<string, unknown>;
};

export type LarkCondition = { field_name: string; operator: string; value?: string[] };

// bitable nests one level only
type LarkFilterGroup = { conjunction: "and" | "or"; conditions: LarkCondition[] };

export type LarkFilter = { conjunction: "and" | "or"; conditions?: LarkCondition[]; children?: LarkFilterGroup[] };

export type LarkSortKey = { field_name: string; desc: boolean };

type SearchOptions = {
  fieldNames?: string[];
  filter?: LarkFilter;
  sort?: LarkSortKey[];
  pageSize?: number;
};

type Page<T> = { items?: T[]; has_more: boolean; page_token?: string };

type SearchPage = Page<LarkRecord> & { total?: number };

// every upstream call aborts on the wire request's own budget
export type Deadline = { remainingMs(): number; check(): void };

class LarkError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "LarkError";
  }
}

// app-scoped, so tenants sharing an app share one mint
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
  readonly cacheKey: string; // digest of all three, so one tenant never reads another's cache
  private readonly tokenKey: string;

  constructor(private readonly credentials: LarkCredentials) {
    const { appId, appSecret, appToken } = credentials;
    this.cacheKey = digest([appId, appSecret, appToken]);
    this.tokenKey = digest([appId, appSecret]);
  }

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
      if (envelope.code === RATE_LIMITED_CODE && deadline.remainingMs() > RATE_LIMIT_BACKOFF_MS * 2) {
        await Bun.sleep(RATE_LIMIT_BACKOFF_MS);
        return await this.request(method, path, deadline, opts, retried);
      }
      if (res.status === 404 || envelope.code === NOT_EXIST_CODE) {
        throw unknownEntity(`lark: ${envelope.msg} (code=${envelope.code})`);
      }
      throw new LarkError(envelope.code, `lark ${path}: code=${envelope.code} ${envelope.msg}`);
    }
    return envelope.data as T;
  }

  private tablesPath(): string {
    return `/open-apis/bitable/v1/apps/${this.credentials.appToken}/tables`;
  }

  // the mint proves the app id and secret, the table read proves the app_token
  // plain Error: /check shows the message to the tenant who typed the credentials
  async checkAccess(deadline: Deadline): Promise<void> {
    try {
      await this.request<{ items?: LarkTable[] }>("GET", this.tablesPath(), deadline, {
        query: { page_size: "1" },
      });
    } catch (error) {
      if (error instanceof ConnectorError && error.status === 404) {
        throw new Error(
          `Lark has no base ${this.credentials.appToken} this app can open: check the token, and that the app was added to the base as a collaborator (${error.message})`,
        );
      }
      throw error instanceof ConnectorError ? new Error(error.message) : error;
    }
  }

  // metadata pages cap at page_size 100
  private async listAll<T>(path: string, deadline: Deadline): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    do {
      deadline.check();
      const page = await this.request<Page<T>>("GET", path, deadline, {
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

  async searchPage(
    tableId: string,
    deadline: Deadline,
    opts: SearchOptions & { pageToken?: string } = {},
  ): Promise<SearchPage> {
    deadline.check();
    const body: Record<string, unknown> = { automatic_fields: false };
    if (opts.fieldNames && opts.fieldNames.length > 0) body.field_names = opts.fieldNames;
    if (opts.filter) body.filter = opts.filter;
    if (opts.sort && opts.sort.length > 0) body.sort = opts.sort;
    return await this.request<SearchPage>("POST", `${this.tablesPath()}/${tableId}/records/search`, deadline, {
      query: {
        page_size: String(Math.min(opts.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)),
        ...(opts.pageToken ? { page_token: opts.pageToken } : {}),
      },
      body,
    });
  }

  // caps nothing; callers stop reading when they have enough
  async *searchAll(tableId: string, deadline: Deadline, opts: SearchOptions = {}): AsyncIterable<LarkRecord[]> {
    let pageToken: string | undefined;
    do {
      const page = await this.searchPage(tableId, deadline, { ...opts, pageToken });
      if (page.items && page.items.length > 0) yield page.items;
      pageToken = page.has_more ? page.page_token : undefined;
    } while (pageToken);
  }

  // text_field_as_array spells text cells the way records/search does
  async getRecord(tableId: string, recordId: string, deadline: Deadline): Promise<LarkRecord | null> {
    const path = `${this.tablesPath()}/${tableId}/records/${encodeURIComponent(recordId)}`;
    try {
      const answer = await this.request<{ record?: LarkRecord }>("GET", path, deadline, {
        query: { text_field_as_array: "true" },
      });
      return answer.record ?? null;
    } catch (error) {
      if (error instanceof LarkError && error.code === RECORD_NOT_FOUND_CODE) return null;
      throw error;
    }
  }

  // every search page carries the filtered total, so one row is enough to count
  async recordTotal(tableId: string, deadline: Deadline, filter?: LarkFilter): Promise<number | null> {
    const page = await this.searchPage(tableId, deadline, { pageSize: 1, ...(filter ? { filter } : {}) });
    return page.total ?? null;
  }
}
