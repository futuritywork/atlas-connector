// bitable field-type codes → atlas types, plus the read-side value flattening.
// a record's fields map omits empty cells entirely, so a missing key reads as null.

import type { AtlasType, AtlasValue } from "@futurity/atlas-connector";
import type { LarkField } from "./lark-api";

export const LARK_TYPE = {
  text: 1,
  number: 2,
  singleSelect: 3,
  multiSelect: 4,
  date: 5,
  checkbox: 7,
  user: 11,
  phone: 13,
  url: 15,
  attachment: 17,
  singleLink: 18,
  lookup: 19,
  formula: 20,
  duplexLink: 21,
  location: 22,
  groupChat: 23,
  createdTime: 1001,
  modifiedTime: 1002,
  createdUser: 1003,
  modifiedUser: 1004,
  autoNumber: 1005,
} as const;

// no decimal or date: bitable numbers are doubles and dates are epoch-ms instants
const ATLAS_TYPE_BY_LARK: Record<number, AtlasType> = {
  [LARK_TYPE.text]: "string",
  [LARK_TYPE.number]: "number",
  [LARK_TYPE.singleSelect]: "string",
  [LARK_TYPE.multiSelect]: "array",
  [LARK_TYPE.date]: "datetime",
  [LARK_TYPE.checkbox]: "boolean",
  [LARK_TYPE.user]: "json",
  [LARK_TYPE.phone]: "string",
  [LARK_TYPE.url]: "string",
  [LARK_TYPE.attachment]: "json",
  [LARK_TYPE.singleLink]: "string",
  [LARK_TYPE.lookup]: "json",
  [LARK_TYPE.formula]: "json",
  [LARK_TYPE.duplexLink]: "string",
  [LARK_TYPE.location]: "json",
  [LARK_TYPE.groupChat]: "json",
  [LARK_TYPE.createdTime]: "datetime",
  [LARK_TYPE.modifiedTime]: "datetime",
  [LARK_TYPE.createdUser]: "json",
  [LARK_TYPE.modifiedUser]: "json",
  [LARK_TYPE.autoNumber]: "string",
};

export function atlasTypeOf(field: LarkField): AtlasType {
  return ATLAS_TYPE_BY_LARK[field.type] ?? "json";
}

// [{text,type,...}] segment arrays (text, barcode, some formula results) → one string
function joinSegments(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const segment of value) {
    if (typeof segment === "string") parts.push(segment);
    else if (segment && typeof segment === "object" && "text" in segment) {
      parts.push(String((segment as { text: unknown }).text ?? ""));
    } else return null;
  }
  return parts.join("");
}

function millisToIso(value: unknown): string | null {
  const millis = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
}

// wire rows carry scalars only: strings, numbers, booleans, null.
// dates cross as ISO-8601 UTC; arrays and objects cross as JSON text.
export function flattenValue(raw: unknown, larkType: number): AtlasValue {
  if (raw === undefined || raw === null) return null;
  switch (larkType) {
    case LARK_TYPE.text:
    case LARK_TYPE.phone:
    case LARK_TYPE.autoNumber:
      return joinSegments(raw) ?? String(raw);
    case LARK_TYPE.number:
      return typeof raw === "number" && Number.isFinite(raw) ? raw : (joinSegments(raw) ?? String(raw));
    case LARK_TYPE.singleSelect:
      return typeof raw === "string" ? raw : JSON.stringify(raw);
    case LARK_TYPE.multiSelect:
      return JSON.stringify(raw);
    case LARK_TYPE.date:
    case LARK_TYPE.createdTime:
    case LARK_TYPE.modifiedTime:
      return millisToIso(raw) ?? String(raw);
    case LARK_TYPE.checkbox:
      return typeof raw === "boolean" ? raw : String(raw) === "true";
    case LARK_TYPE.url: {
      if (raw && typeof raw === "object" && "link" in raw) {
        const { link, text } = raw as { link?: unknown; text?: unknown };
        return String(link ?? text ?? "");
      }
      return joinSegments(raw) ?? String(raw);
    }
    case LARK_TYPE.singleLink:
    case LARK_TYPE.duplexLink: {
      // link cells read as { link_record_ids: [...] }; only the first id crosses, as text, so the field joins against record_id
      const ids = raw && typeof raw === "object" && "link_record_ids" in raw ? raw.link_record_ids : raw;
      return Array.isArray(ids) && ids.length > 0 ? String(ids[0]) : null;
    }
    case LARK_TYPE.formula:
    case LARK_TYPE.lookup: {
      // reads as { type, value } — keep the value; segment-array values flatten to text
      if (raw && typeof raw === "object" && "value" in raw) {
        const inner = (raw as { value: unknown }).value;
        return joinSegments(inner) ?? JSON.stringify(inner);
      }
      return joinSegments(raw) ?? JSON.stringify(raw);
    }
    default: {
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
      return JSON.stringify(raw);
    }
  }
}
