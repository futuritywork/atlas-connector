import type { AtlasType, AtlasValue } from "@futurity/atlas-connector";
import { z } from "zod";
import type { LarkField } from "./lark-api";

export const RECORD_ID = "record_id"; // every record carries it; no table declares it as a field

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

// no decimal or date: bitable numbers are doubles, dates epoch-ms instants
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

// text, barcode and some formula cells arrive as [{ text, type }] segments
const Segments = z.array(z.union([z.string(), z.object({ text: z.unknown() })]));

// a link cell is { link_record_ids } from a search and [{ record_ids }] from a single-record read
const SearchedLink = z.object({ link_record_ids: z.array(z.string()) });
const ReadLink = z.tuple([z.object({ record_ids: z.array(z.string()) })]).rest(z.unknown());
const BareIds = z.array(z.string());

// formula and lookup cells read as { type, value }
const Wrapped = z.object({ value: z.unknown() });

function joinSegments(value: unknown): string | null {
  if (typeof value === "string") return value;
  const segments = Segments.safeParse(value);
  if (!segments.success) return null;
  return segments.data.map((segment) => (typeof segment === "string" ? segment : String(segment.text ?? ""))).join("");
}

function linkRecordIds(raw: unknown): string[] {
  const searched = SearchedLink.safeParse(raw);
  if (searched.success) return searched.data.link_record_ids;
  const read = ReadLink.safeParse(raw);
  if (read.success) return read.data[0].record_ids;
  return BareIds.safeParse(raw).data ?? [];
}

function millisToIso(value: unknown): string | null {
  const millis = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
}

export function flattenValue(raw: unknown, larkType: number): AtlasValue {
  if (raw === undefined || raw === null) return null;
  switch (larkType) {
    case LARK_TYPE.text:
    case LARK_TYPE.phone:
    case LARK_TYPE.autoNumber:
      return joinSegments(raw) ?? String(raw);
    case LARK_TYPE.number: {
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : String(raw);
      // a single-record read spells a number as decimal text
      const text = joinSegments(raw) ?? String(raw);
      const parsed = Number(text);
      return text.trim() !== "" && Number.isFinite(parsed) ? parsed : text;
    }
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
      // only the first id crosses, so the field joins against record_id
      return linkRecordIds(raw)[0] ?? null;
    }
    case LARK_TYPE.formula:
    case LARK_TYPE.lookup: {
      const inner = Wrapped.safeParse(raw).data?.value ?? raw;
      return joinSegments(inner) ?? JSON.stringify(inner);
    }
    default: {
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
      return JSON.stringify(raw);
    }
  }
}
