import { describe, expect, test } from "bun:test";
import { bearerGuard } from "./auth";
import { ConnectorError } from "./errors";

const TOKEN = "a".repeat(32);
const guard = bearerGuard(TOKEN);

function statusOf(fn: () => void): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConnectorError) return error.status;
    throw error;
  }
  throw new Error("expected a ConnectorError");
}

describe("bearerGuard", () => {
  test("accepts the exact token", () => {
    expect(() => guard(`Bearer ${TOKEN}`)).not.toThrow();
  });

  test("rejects a missing header with 401", () => {
    expect(statusOf(() => guard(undefined))).toBe(401);
  });

  test("rejects a non-bearer scheme with 401", () => {
    expect(statusOf(() => guard(`Basic ${TOKEN}`))).toBe(401);
  });

  test("rejects an empty bearer with 401", () => {
    expect(statusOf(() => guard("Bearer "))).toBe(401);
  });

  test("rejects a wrong token of equal length with 401", () => {
    expect(statusOf(() => guard(`Bearer ${"b".repeat(32)}`))).toBe(401);
  });

  test("rejects a wrong token of different length with 401, never a crypto throw", () => {
    // sha256 equalizes length before timingSafeEqual, so a short guess cannot crash the guard
    expect(statusOf(() => guard("Bearer short"))).toBe(401);
    expect(statusOf(() => guard(`Bearer ${"c".repeat(4096)}`))).toBe(401);
  });

  test("guards are independent closures over their own token", () => {
    const other = bearerGuard("z".repeat(32));
    expect(() => other(`Bearer ${"z".repeat(32)}`)).not.toThrow();
    expect(statusOf(() => other(`Bearer ${TOKEN}`))).toBe(401);
  });
});
