import { describe, expect, test } from "bun:test";
import { AtlasJson, ConnectorError, OPS } from "@futurity/atlas-connector";
import { ATLAS_JSON } from "./capability";
import { StampsConnector } from "./connector";

const STORE = {
  id: 310,
  name: "development",
  code: null,
  area: "Jakarta Pusat",
  display_name: "Development Store",
  address: "Test address",
  phone: "000",
  email: "store@example.test",
  slug: "development-store",
  latitude: -6.1,
  longitude: 106.8,
  timezone: "Asia/Jakarta",
  photo_url: null,
  is_active: true,
  description: null,
  regency: null,
  province: "DKI Jakarta",
  store_hours: null,
  photos_url: [],
};

const SECOND_STORE = {
  ...STORE,
  id: 311,
  name: "inactive",
  display_name: "Inactive Store",
  area: "Bandung",
  is_active: false,
};

const REWARD = {
  id: 1,
  code: null,
  name: "Small reward",
  stamps_to_redeem: 3,
  user_redemption_limit: null,
  membership_levels: [],
  picture_url: "https://example.test/reward.png",
  landscape_url: "https://example.test/reward-wide.png",
  is_active: true,
  extra_data: {},
  start_date: "2026-01-01",
  end_date: "2026-12-31",
  type: 1,
  redeemable: true,
  is_visible: true,
  merchant_code: "TEST",
  description: "Test reward",
  terms: "Test terms",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function collect(rows: AsyncIterable<Record<string, unknown>[]>) {
  const answer: Record<string, unknown>[] = [];
  for await (const batch of rows) answer.push(...batch);
  return answer;
}

describe("Stamps capability", () => {
  test("advertises the request-scoped staging contract the connector honors", () => {
    expect(AtlasJson.parse(ATLAS_JSON)).toEqual({
      protocolVersion: 1,
      slug: "stamps",
      capabilities: {
        operators: [...OPS],
        dateBucket: false,
        sort: "none",
        offset: false,
        count: "scan",
        join: false,
        enforcesDeclaredKeys: false,
        probeConcurrency: 2,
        cheapProbes: false,
      },
      credentialSchema: [
        {
          key: "merchantToken",
          label: "Merchant token",
          type: "password",
          required: true,
          placeholder: "40-character merchant token",
          help: "Stamps CRM → **Settings → API Settings → Merchant → Token**. See the [Stamps API v4 documentation](https://staging-crm2.stamps.id/api/v4/docs).",
        },
        {
          key: "baseUrl",
          label: "API base URL",
          type: "text",
          required: false,
          placeholder: "https://staging-crm2.stamps.id",
          help: "Optional Stamps staging host. Leave blank for `https://staging-crm2.stamps.id`; the secondary `https://staging-crm.stamps.id` host is also accepted.",
        },
      ],
      endpoints: [],
    });
  });
});

describe("Stamps credentials", () => {
  test("check sends the merchant token to the default staging stores endpoint", async () => {
    let request: Request | undefined;
    const connector = new StampsConnector(async (input, init) => {
      request = new Request(input, init);
      return json({ stores: [STORE] });
    });

    await connector.check({
      credentials: { merchantToken: "test-merchant-token" },
      timeoutMs: 1_000,
    });

    expect(request?.url).toBe("https://staging-crm2.stamps.id/api/v4/stores/");
    expect(request?.headers.get("authorization")).toBe("token test-merchant-token");
  });

  test("accepts the documented secondary staging origin", async () => {
    let requestedUrl: string | undefined;
    const connector = new StampsConnector(async (input) => {
      requestedUrl = String(input);
      return json({ stores: [] });
    });

    await connector.check({
      credentials: {
        merchantToken: "test-merchant-token",
        baseUrl: "https://staging-crm.stamps.id",
      },
      timeoutMs: 1_000,
    });

    expect(requestedUrl).toBe("https://staging-crm.stamps.id/api/v4/stores/");
  });

  test("rejects an arbitrary base URL before any request can leave", async () => {
    let requested = false;
    const connector = new StampsConnector(async () => {
      requested = true;
      return json({ stores: [] });
    });

    await expect(
      connector.check({
        credentials: {
          merchantToken: "test-merchant-token",
          baseUrl: "https://attacker.example",
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("baseUrl must be one of the documented Stamps staging hosts");
    expect(requested).toBe(false);
  });

  test("reports a rejected token without echoing the credential", async () => {
    const merchantToken = "secret-that-must-never-appear-in-errors";
    const connector = new StampsConnector(async () =>
      json(
        {
          error_message: `Request Unauthorized for ${merchantToken}`,
          error_code: "unauthorized",
        },
        401,
      ),
    );

    let thrown: unknown;
    try {
      await connector.check({ credentials: { merchantToken }, timeoutMs: 1_000 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConnectorError);
    expect((thrown as ConnectorError).status).toBe(401);
    expect((thrown as Error).message).toContain("Request Unauthorized");
    expect((thrown as Error).message).not.toContain(merchantToken);
  });

  test("classifies a malformed success body as an upstream contract failure", async () => {
    const connector = new StampsConnector(async () => json({ stores: "not-an-array" }));

    let thrown: unknown;
    try {
      await connector.check({
        credentials: { merchantToken: "test-merchant-token" },
        timeoutMs: 1_000,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConnectorError);
    expect((thrown as ConnectorError).status).toBe(500);
    expect((thrown as Error).message).toBe("Stamps API returned an invalid response");
  });
});

describe("Stamps discovery", () => {
  test("declares only scalar store and reward fields", async () => {
    const connector = new StampsConnector(async () => {
      throw new Error("discovery must not call Stamps");
    });

    const answer = await connector.discover({
      credentials: { merchantToken: "test-merchant-token" },
      timeoutMs: 1_000,
    });

    expect(
      answer.tables.map((table) => ({
        name: table.name,
        primaryKey: table.primaryKey,
        fields: Object.fromEntries(
          table.fields.map((field) => [
            field.name,
            [field.type, field.nullable, field.unique],
          ]),
        ),
      })),
    ).toEqual([
      {
        name: "stores",
        primaryKey: ["id"],
        fields: {
          id: ["number", false, true],
          name: ["string", false, false],
          code: ["string", true, false],
          area: ["string", true, false],
          display_name: ["string", true, false],
          address: ["string", true, false],
          phone: ["string", true, false],
          email: ["string", true, false],
          slug: ["string", true, false],
          latitude: ["number", true, false],
          longitude: ["number", true, false],
          timezone: ["string", true, false],
          photo_url: ["string", true, false],
          is_active: ["boolean", false, false],
          description: ["string", true, false],
          regency: ["string", true, false],
          province: ["string", true, false],
        },
      },
      {
        name: "rewards",
        primaryKey: ["id"],
        fields: {
          id: ["number", false, true],
          code: ["string", true, false],
          name: ["string", false, false],
          stamps_to_redeem: ["number", false, false],
          user_redemption_limit: ["number", true, false],
          picture_url: ["string", false, false],
          landscape_url: ["string", false, false],
          is_active: ["boolean", false, false],
          start_date: ["date", true, false],
          end_date: ["date", true, false],
          type: ["string", false, false],
          redeemable: ["boolean", false, false],
          is_visible: ["boolean", false, false],
          merchant_code: ["string", false, false],
          description: ["string", false, false],
          terms: ["string", false, false],
        },
      },
    ]);
  });
});

describe("Stamps queries", () => {
  test("filters stores and returns only the requested scalar fields", async () => {
    const connector = new StampsConnector(async () =>
      json({ stores: [STORE, SECOND_STORE] }),
    );

    const rows = await collect(
      connector.query({
        table: "stores",
        and: [{ field: "is_active", op: "eq", value: true }],
        sort: [],
        fields: ["id", "display_name", "is_active"],
        fieldTypes: { is_active: "boolean" },
        credentials: { merchantToken: "test-merchant-token" },
        timeoutMs: 1_000,
      }),
    );

    expect(rows).toEqual([
      { id: 310, display_name: "Development Store", is_active: true },
    ]);
  });

  test("follows the reward cursor until enough filtered rows are found", async () => {
    const connector = new StampsConnector(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("per_page")).toBe("100");
      const cursor = url.searchParams.get("last_reward_id");
      if (cursor === null) {
        return json({
          vouchers: [],
          rewards: [REWARD, { ...REWARD, id: 2, name: "Medium reward", stamps_to_redeem: 10 }],
          membership: null,
          user: null,
          has_next: true,
        });
      }
      if (cursor === "2") {
        return json({
          vouchers: [],
          rewards: [{ ...REWARD, id: 3, name: "Large reward", stamps_to_redeem: 20 }],
          membership: null,
          user: null,
          has_next: false,
        });
      }
      return json({ error_message: "wrong cursor", error_code: "bad_cursor" }, 400);
    });

    const rows = await collect(
      connector.query({
        table: "rewards",
        and: [{ field: "stamps_to_redeem", op: "gt", value: 5 }],
        sort: [],
        limit: 2,
        fields: ["id", "name", "stamps_to_redeem", "type"],
        fieldTypes: { stamps_to_redeem: "number", type: "string" },
        credentials: { merchantToken: "test-merchant-token" },
        timeoutMs: 1_000,
      }),
    );

    expect(rows).toEqual([
      { id: 2, name: "Medium reward", stamps_to_redeem: 10, type: "1" },
      { id: 3, name: "Large reward", stamps_to_redeem: 20, type: "1" },
    ]);
  });

  test("counts filtered rewards across every cursor page", async () => {
    const connector = new StampsConnector(async (input) => {
      const cursor = new URL(String(input)).searchParams.get("last_reward_id");
      if (cursor === null) {
        return json({
          vouchers: [],
          rewards: [REWARD, { ...REWARD, id: 2, is_active: false }],
          membership: null,
          user: null,
          has_next: true,
        });
      }
      return json({
        vouchers: [],
        rewards: [{ ...REWARD, id: 3 }],
        membership: null,
        user: null,
        has_next: false,
      });
    });

    const count = await connector.count({
      table: "rewards",
      and: [{ field: "is_active", op: "eq", value: true }],
      fieldTypes: { is_active: "boolean" },
      credentials: { merchantToken: "test-merchant-token" },
      timeoutMs: 1_000,
    });

    expect(count).toBe(2);
  });

  test("stops when a reward cursor does not advance", async () => {
    let requests = 0;
    const connector = new StampsConnector(async () => {
      requests += 1;
      if (requests > 2) {
        return json(
          { error_message: "unexpected second page", error_code: "bad_cursor" },
          400,
        );
      }
      return json({
        vouchers: [],
        rewards: [REWARD],
        membership: null,
        user: null,
        has_next: true,
      });
    });

    await expect(
      collect(
        connector.query({
          table: "rewards",
          and: [],
          sort: [],
          fields: ["id"],
          credentials: { merchantToken: "test-merchant-token" },
          timeoutMs: 1_000,
        }),
      ),
    ).rejects.toThrow("Stamps rewards pagination did not advance");
    expect(requests).toBe(2);
  });

  test("rejects sort, offset, and join shapes the capability does not advertise", async () => {
    const connector = new StampsConnector(async () => json({ stores: [STORE] }));
    const baseRequest = {
      table: "stores",
      and: [],
      sort: [],
      fields: ["id"],
      credentials: { merchantToken: "test-merchant-token" },
      timeoutMs: 1_000,
    };

    const unsupportedRequests = [
      { ...baseRequest, sort: [{ field: "id", dir: "asc" as const }] },
      { ...baseRequest, offset: 1 },
      {
        ...baseRequest,
        joins: [
          {
            fromTable: "stores",
            toTable: "stores",
            fromField: "id",
            toField: "id",
            fields: [{ field: "id", type: "number" as const }],
          },
        ],
      },
    ];

    for (const request of unsupportedRequests) {
      await expect(collect(connector.query(request))).rejects.toThrow(
        "sorting, offsets, and joins are not supported",
      );
    }
  });

  test("rejects an unknown projection field instead of returning a null column", async () => {
    const connector = new StampsConnector(async () => json({ stores: [STORE] }));

    await expect(
      collect(
        connector.query({
          table: "stores",
          and: [],
          sort: [],
          fields: ["missing"],
          credentials: { merchantToken: "test-merchant-token" },
          timeoutMs: 1_000,
        }),
      ),
    ).rejects.toThrow("unknown projection field 'missing'");
  });
});
