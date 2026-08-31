import { describe, expect, test } from "bun:test";
import { postgres } from "./flavor";
import { projectExpression, renderValue } from "./values";

const flavor = postgres();

describe("projectExpression", () => {
  test("decimal casts to server-side text", () => {
    expect(projectExpression(flavor, "amount", "decimal")).toBe(`"amount"::text`);
  });

  test("date and datetime render ISO", () => {
    expect(projectExpression(flavor, "d", "date")).toBe(`to_char("d", 'YYYY-MM-DD')`);
    expect(projectExpression(flavor, "ts", "datetime")).toBe(`to_char("ts", 'YYYY-MM-DD"T"HH24:MI:SS')`);
  });

  test("everything else is the bare quoted column", () => {
    expect(projectExpression(flavor, "id", "int")).toBe(`"id"`);
    expect(projectExpression(flavor, "tags", "text_array")).toBe(`"tags"`);
  });
});

describe("renderValue", () => {
  test("null is null for every kind", () => {
    expect(renderValue(null, "int")).toBeNull();
    expect(renderValue(undefined, "text")).toBeNull();
  });

  test("safe ints stay numbers, past 2^53 they stay digit-exact text", () => {
    expect(renderValue(5, "int")).toBe(5);
    expect(renderValue("42", "int")).toBe(42);
    expect(renderValue("9007199254740993", "int")).toBe("9007199254740993");
    expect(renderValue("-9007199254740993", "int")).toBe("-9007199254740993");
  });

  test("a non-integer int-wire string falls back to text", () => {
    expect(renderValue("abc", "int")).toBe("abc");
  });

  test("decimal, date, datetime and text stringify", () => {
    expect(renderValue("10.250", "decimal")).toBe("10.250");
    expect(renderValue(new Date("2026-01-02T03:04:05Z"), "datetime")).toBeString();
  });

  test("boolean coerces", () => {
    expect(renderValue(true, "boolean")).toBe(true);
    expect(renderValue(0, "boolean")).toBe(false);
  });

  test("text_array crosses as JSON text and rejects driver literals", () => {
    expect(renderValue(["a", "b"], "text_array")).toBe(`["a","b"]`);
    expect(() => renderValue("{a,b}", "text_array")).toThrow("text_array expected a JS array");
  });
});
