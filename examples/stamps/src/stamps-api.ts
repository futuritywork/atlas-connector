import {
  badRequest,
  ConnectorError,
  type Credentials,
  timeout,
  unauthorized,
} from "@futurity/atlas-connector";
import { z } from "zod";

const DEFAULT_BASE_URL = "https://staging-crm2.stamps.id";
const STAGING_BASE_URLS = [DEFAULT_BASE_URL, "https://staging-crm.stamps.id"] as const;

const StampsCredentials = z
  .object({
    merchantToken: z.string().trim().min(1),
    baseUrl: z.enum(STAGING_BASE_URLS).default(DEFAULT_BASE_URL),
  })
  .strict();

const OptionalStoreString = z.string().nullable().default(null);
const OptionalStoreNumber = z.number().finite().nullable().default(null);

const StoreSchema = z.object({
  id: z.number().int().safe(),
  name: z.string(),
  code: OptionalStoreString,
  area: OptionalStoreString,
  display_name: OptionalStoreString,
  address: OptionalStoreString,
  phone: OptionalStoreString,
  email: OptionalStoreString,
  slug: OptionalStoreString,
  latitude: OptionalStoreNumber,
  longitude: OptionalStoreNumber,
  timezone: OptionalStoreString,
  photo_url: OptionalStoreString,
  is_active: z.boolean(),
  description: OptionalStoreString,
  regency: OptionalStoreString,
  province: OptionalStoreString,
});

const StoreIndex = z.object({ stores: z.array(StoreSchema) });
const REWARD_TYPES = ["1", "3", "4", "5"] as const;
const RewardSchema = z.object({
  id: z.number().int().safe(),
  code: z.string().nullable(),
  name: z.string(),
  stamps_to_redeem: z.number().int().safe(),
  user_redemption_limit: z.number().int().safe().nullable(),
  picture_url: z.string(),
  landscape_url: z.string(),
  is_active: z.boolean(),
  start_date: z.iso.date().nullable(),
  end_date: z.iso.date().nullable(),
  type: z
    .union([z.literal([1, 3, 4, 5]), z.enum(REWARD_TYPES)])
    .transform(String)
    .pipe(z.enum(REWARD_TYPES)),
  redeemable: z.boolean(),
  is_visible: z.boolean(),
  merchant_code: z.string(),
  description: z.string(),
  terms: z.string(),
});
const RewardIndex = z.object({
  rewards: z.array(RewardSchema),
  has_next: z.boolean(),
});

export class StampsClient {
  private readonly baseUrl: string;
  private readonly deadline: number;
  private readonly merchantToken: string;

  constructor(credentials: Credentials, private readonly timeoutMs: number) {
    const parsed = StampsCredentials.safeParse(credentials);
    if (!parsed.success) {
      throw badRequest(
        "merchantToken is required; baseUrl must be a documented Stamps staging host",
      );
    }
    this.baseUrl = parsed.data.baseUrl;
    this.deadline = Date.now() + timeoutMs;
    this.merchantToken = parsed.data.merchantToken;
  }

  async listStores(): Promise<z.infer<typeof StoreSchema>[]> {
    const answer = await this.get("/api/v4/stores/", StoreIndex);
    return answer.stores;
  }

  async *listRewards(): AsyncIterable<z.infer<typeof RewardSchema>[]> {
    let cursor: number | undefined;
    while (true) {
      const query = new URLSearchParams({ per_page: "100" });
      if (cursor !== undefined) query.set("last_reward_id", String(cursor));
      const answer = await this.get(
        `/api/v4/rewards/?${query}`,
        RewardIndex,
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
  ): Promise<T> {
    const remainingMs = this.deadline - Date.now();
    if (remainingMs <= 0) {
      throw timeout(`Stamps request exceeded the ${this.timeoutMs}ms budget`);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          accept: "application/json",
          authorization: `token ${this.merchantToken}`,
        },
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw timeout(`Stamps request exceeded the ${this.timeoutMs}ms budget`);
      }
      throw error;
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw unauthorized("Stamps rejected the merchant token: Request Unauthorized");
      }
      if (response.status === 400) {
        throw badRequest("Stamps rejected the request");
      }
      throw new ConnectorError(500, `Stamps API request failed with HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ConnectorError(500, "Stamps API returned a non-JSON response");
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ConnectorError(500, "Stamps API returned an invalid response");
    }
    return parsed.data;
  }
}
