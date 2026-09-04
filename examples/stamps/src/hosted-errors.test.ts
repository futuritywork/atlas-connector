import { describe, expect, test } from "bun:test";
import { createApp } from "../../../src";
import type { AtlasConnector } from "../../../src/connector";
import { StampsConnector } from "./connector";

const TOKEN = "0123456789abcdef0123456789abcdef";
const AUTH = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};
const CREDENTIALS = { merchantToken: "test-merchant-token" };

// A file dependency is a separate nominal SDK copy; the host accepts its runtime ABI.
const app = createApp(
  new StampsConnector(async () => {
    throw new Error("validation failures must not call Stamps");
  }) as unknown as AtlasConnector,
  { token: TOKEN },
);

function query(body: Record<string, unknown>): Promise<Response> {
  return app.handle(
    new Request("http://connector.test/query", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        table: "stores",
        and: [],
        sort: [],
        fields: ["id"],
        credentials: CREDENTIALS,
        timeoutMs: 1_000,
        ...body,
      }),
    }),
  );
}

describe("hosted Stamps errors", () => {
  test.each([
    ["unknown table", { table: "missing" }, 404, "unknown_entity"],
    [
      "unknown filter field",
      { and: [{ field: "missing", op: "eq", value: 1 }] },
      422,
      "unsupported",
    ],
    [
      "unsupported join",
      {
        joins: [
          {
            fromTable: "stores",
            toTable: "rewards",
            fromField: "id",
            toField: "id",
            fields: [{ field: "name", as: "reward_name", type: "string" }],
          },
        ],
      },
      422,
      "unsupported",
    ],
  ])(
    "preserves the %s error across the workspace package boundary",
    async (_, body, status, code) => {
      const response = await query(body);

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    },
  );
});
