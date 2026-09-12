import { describe, expect, test } from "bun:test";
import { ConnectorError } from "../serve/errors";
import { assertKnownFields } from "./assert-known-fields";

const KNOWN = ["id", "name"];

function rejection(req: Parameters<typeof assertKnownFields>[0]): ConnectorError {
  try {
    assertKnownFields(req, KNOWN);
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw error;
  }
  throw new Error("assertKnownFields accepted an unknown field");
}

describe("assertKnownFields", () => {
  test("collects the requested, filtered and sorted fields into one set", () => {
    const requested = assertKnownFields(
      {
        fields: ["id"],
        and: [{ field: "name", op: "eq", value: "x" }],
        or: [[{ field: "id", op: "notnull" }]],
        sort: [{ field: "name", dir: "asc" }],
      },
      KNOWN,
    );
    expect([...requested].sort()).toEqual(["id", "name"]);
  });

  test("a 422 names the offending field", () => {
    for (const req of [
      { fields: ["ghost"], and: [] },
      { and: [{ field: "ghost", op: "eq" as const, value: 1 }] },
      { and: [], or: [[{ field: "ghost", op: "eq" as const, value: 1 }]] },
      { and: [], sort: [{ field: "ghost", dir: "asc" as const }] },
    ]) {
      const error = rejection(req);
      expect(error.status).toBe(422);
      expect(error.message).toContain("ghost");
    }
  });
});
