import { describe, expect, test } from "bun:test";
import { createFilterSetSchema, EsbDatetimeValue } from "./schemas";

const FIELD_TYPES = {
  happenedAt: "datetime",
  businessDate: "date",
  label: "string",
} as const;

describe("ESB datetime schemas", () => {
  test("canonicalizes explicit-zone datetimes and preserves other Atlas values", () => {
    expect(EsbDatetimeValue.parse("2024-01-01T09:00:00+07:00")).toBe("2024-01-01T02:00:00.000Z");
    expect(EsbDatetimeValue.parse("2024-01-01t02:00:00z")).toBe("2024-01-01t02:00:00z");
    expect(EsbDatetimeValue.parse("2024-01-01T09:00:00")).toBe("2024-01-01T09:00:00");
    expect(EsbDatetimeValue.parse("2024-01-01")).toBe("2024-01-01");
    expect(EsbDatetimeValue.parse("2024-02-30T00:00:00Z")).toBe("2024-02-30T00:00:00Z");
    expect(EsbDatetimeValue.parse("2024-01-01T24:00:00Z")).toBe("2024-01-01T24:00:00Z");
    expect(EsbDatetimeValue.parse("2024-01-01T00:00:00+24:00")).toBe("2024-01-01T00:00:00+24:00");
    expect(EsbDatetimeValue.parse(null)).toBeNull();
  });

  test("normalizes datetime operands and preserves catalog date operands", () => {
    const filters = {
      and: [
        { field: "happenedAt", op: "eq", value: "2024-01-01T02:00:00Z" },
        { field: "businessDate", op: "eq", value: "2024-01-01" },
        { field: "label", op: "isnull" },
      ],
      or: [
        [{ field: "happenedAt", op: "in", values: ["2024-01-01T09:00:00+07:00", null] }],
        [{ field: "label", op: "startswith", value: "2024-01-01T02:00:00Z" }],
      ],
    };

    expect(createFilterSetSchema(FIELD_TYPES).parse(filters)).toEqual({
      and: [
        { field: "happenedAt", op: "eq", value: "2024-01-01T02:00:00.000Z" },
        { field: "businessDate", op: "eq", value: "2024-01-01" },
        { field: "label", op: "isnull" },
      ],
      or: [
        [{ field: "happenedAt", op: "in", values: ["2024-01-01T02:00:00.000Z", null] }],
        [{ field: "label", op: "startswith", value: "2024-01-01T02:00:00Z" }],
      ],
    });
    expect(filters.and[0]?.value).toBe("2024-01-01T02:00:00Z");
  });

  test("retains the strict Atlas filter contract", () => {
    const result = createFilterSetSchema(FIELD_TYPES).safeParse({
      and: [{ field: "happenedAt", op: "eq", value: "2024-01-01T02:00:00Z", extra: true }],
    });
    expect(result.success).toBe(false);
  });
});
