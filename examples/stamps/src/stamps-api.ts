import {
  badRequest,
  ConnectorError,
  type Credentials,
  timeout,
  unauthorized,
} from "@futurity/atlas-connector";
import { z } from "zod";

const DEFAULT_BASE_URL = "https://staging-crm2.stamps.id";
const ALLOWED_ORIGINS = new Set([
  DEFAULT_BASE_URL,
  "https://staging-crm.stamps.id",
]);

const StampsCredentials = z
  .object({
    merchantToken: z.string().trim().min(1),
    baseUrl: z.string().trim().min(1).optional(),
  })
  .strict();

const StoreSchema = z.object({
  id: z.number().int().safe(),
  name: z.string(),
  code: z.string().nullable(),
  area: z.string().nullable(),
  display_name: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  slug: z.string().nullable(),
  latitude: z.number().finite().nullable(),
  longitude: z.number().finite().nullable(),
  timezone: z.string().nullable(),
  photo_url: z.string().nullable(),
  is_active: z.boolean(),
  description: z.string().nullable(),
  regency: z.string().nullable(),
  province: z.string().nullable(),
});

const StoreIndex = z.object({ stores: z.array(StoreSchema) });
const RewardSchema = z.object({
  id: z.number().int().safe(),
  code: z.string().nullable(),
  name: z.string(),
  stamps_to_redeem: z.number().int().safe(),
  user_redemption_limit: z.number().int().safe().nullable(),
  membership_levels: z.array(z.unknown()),
  picture_url: z.string(),
  landscape_url: z.string(),
  is_active: z.boolean(),
  extra_data: z.record(z.string(), z.unknown()).nullable(),
  start_date: z.iso.date().nullable(),
  end_date: z.iso.date().nullable(),
  type: z.union([z.number().int(), z.string()]),
  redeemable: z.boolean(),
  is_visible: z.boolean(),
  merchant_code: z.string(),
  description: z.string(),
  terms: z.string(),
});
const RewardIndex = z.object({
  vouchers: z.array(z.unknown()),
  rewards: z.array(RewardSchema),
  membership: z.unknown().nullable(),
  user: z.unknown().nullable(),
  has_next: z.boolean(),
});
const ErrorOut = z.object({
  error_message: z.string(),
  error_code: z.string(),
});

export type StampsStore = z.infer<typeof StoreSchema>;
export type StampsReward = z.infer<typeof RewardSchema>;

export type StampsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function baseUrlOf(credentials: z.infer<typeof StampsCredentials>): string {
  let url: URL;
  try {
    url = new URL(credentials.baseUrl ?? DEFAULT_BASE_URL);
  } catch {
    throw badRequest("baseUrl must be one of the documented Stamps staging hosts");
  }

  const isBareOrigin =
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  if (!isBareOrigin || !ALLOWED_ORIGINS.has(url.origin)) {
    throw badRequest("baseUrl must be one of the documented Stamps staging hosts");
  }
  return url.origin;
}

export class StampsClient {
  private readonly baseUrl: string;
  private readonly merchantToken: string;

  constructor(
    credentials: Credentials,
    private readonly fetcher: StampsFetch = fetch,
  ) {
    const parsed = StampsCredentials.safeParse(credentials);
    if (!parsed.success) {
      throw badRequest("merchantToken is required; baseUrl is optional");
    }
    this.baseUrl = baseUrlOf(parsed.data);
    this.merchantToken = parsed.data.merchantToken;
  }

  async listStores(timeoutMs: number): Promise<StampsStore[]> {
    const answer = await this.get("/api/v4/stores/", StoreIndex, timeoutMs);
    return answer.stores;
  }

  async *listRewards(timeoutMs: number): AsyncIterable<StampsReward[]> {
    let cursor: number | undefined;
    while (true) {
      const query = new URLSearchParams({ per_page: "100" });
      if (cursor !== undefined) query.set("last_reward_id", String(cursor));
      const answer = await this.get(
        `/api/v4/rewards/?${query}`,
        RewardIndex,
        timeoutMs,
      );
      yield answer.rewards;
      if (!answer.has_next) return;

      const nextCursor = answer.rewards.at(-1)?.id;
      if (nextCursor === undefined || nextCursor === cursor) {
        throw new ConnectorError(500, "Stamps rewards pagination did not advance");
      }
      cursor = nextCursor;
    }
  }

  private async get<T>(
    path: string,
    schema: z.ZodType<T>,
    timeoutMs: number,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        headers: {
          accept: "application/json",
          authorization: `token ${this.merchantToken}`,
        },
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw timeout(`Stamps request exceeded the ${timeoutMs}ms budget`);
      }
      throw error;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ConnectorError(500, "Stamps API returned a non-JSON response");
    }

    if (!response.ok) {
      const upstream = ErrorOut.safeParse(body);
      const detail = upstream.success ? upstream.data.error_message : `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) {
        throw unauthorized("Stamps rejected the merchant token: Request Unauthorized");
      }
      if (response.status === 400) {
        throw badRequest(`Stamps rejected the request: ${detail}`);
      }
      throw new ConnectorError(500, `Stamps API request failed with HTTP ${response.status}`);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ConnectorError(500, "Stamps API returned an invalid response");
    }
    return parsed.data;
  }
}
