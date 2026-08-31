import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ConnectorError } from "./errors";
import { parseBody, withTimeout } from "./http";

describe("parseBody", () => {
  const schema = z.object({ table: z.string(), timeoutMs: z.number().int().min(1) }).strict();

  test("returns the parsed data", () => {
    expect(parseBody(schema, { table: "t", timeoutMs: 5 })).toEqual({ table: "t", timeoutMs: 5 });
  });

  test("a malformed body throws 400, never 422", () => {
    try {
      parseBody(schema, { table: 7, timeoutMs: 5 });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).status).toBe(400);
      expect((error as ConnectorError).message).toContain("table");
    }
  });

  test("issue paths are joined into the message", () => {
    const nested = z.object({ sort: z.array(z.object({ dir: z.enum(["asc", "desc"]) })) });
    try {
      parseBody(nested, { sort: [{ dir: "sideways" }] });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as ConnectorError).message).toContain("sort.0.dir");
    }
  });
});

describe("withTimeout", () => {
  test("resolves the work's value", async () => {
    expect(await withTimeout(1000, async () => 42)).toBe(42);
  });

  test("expiry rejects with a 408 ConnectorError", async () => {
    const never = () => new Promise<number>(() => {});
    try {
      await withTimeout(20, never);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).status).toBe(408);
      expect((error as ConnectorError).message).toContain("20ms");
    }
  });

  test("the work's own rejection wins the race untouched", async () => {
    const boom = new Error("boom");
    await expect(withTimeout(1000, () => Promise.reject(boom))).rejects.toBe(boom);
  });
});
