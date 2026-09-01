import { describe, expect, test } from "bun:test";
import { ConnectorError } from "../serve/errors";
import { assertKnownFields } from "./assert-known-fields";

const known = ["id", "name"];

describe("assertKnownFields", () => {
  test("passes filters whose fields the connector can push down", () => {
    expect(() =>
      assertKnownFields({ and: [{ field: "id", op: "eq", value: 1 }] }, known),
    ).not.toThrow();
  });

  test("an unknown and-field is a 422, never a silently unfiltered read", () => {
    let thrown: unknown;
    try {
      assertKnownFields({ and: [{ field: "ghost", op: "eq", value: 1 }] }, known);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect((thrown as ConnectorError).status).toBe(422);
    expect((thrown as ConnectorError).message).toContain("ghost");
  });

  test("or-groups are checked too", () => {
    expect(() =>
      assertKnownFields(
        { and: [], or: [[{ field: "id", op: "eq", value: 1 }], [{ field: "ghost", op: "isnull" }]] },
        known,
      ),
    ).toThrow("ghost");
  });
});
