import type { AtlasValue } from "../wire/vocabulary";
import type { WireKind } from "./catalog";
import type { SqlFlavor } from "./flavor";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// per-column projection; render in SQL not the driver, so the wire never depends on driver decoding
export function projectExpression(flavor: SqlFlavor, column: string, wire: WireKind): string {
  const c = flavor.quoteIdent(column);
  switch (wire) {
    case "decimal":
      // exact server-side text; a JS float would silently reshape 10.250 or a >2^53 value
      return flavor.castText(c);
    case "date":
      return flavor.renderDate(c);
    case "datetime":
      return flavor.renderDatetime(c);
    default:
      return c;
  }
}

// raw driver output → AtlasValue; drivers disagree on decoding (strings for int8/numeric,
// numbers for int4, Date for timestamps), so the wire kind decides, not typeof
export function renderValue(raw: unknown, wire: WireKind): AtlasValue {
  if (raw == null) return null;
  switch (wire) {
    case "int": {
      // JSON number when it round-trips exactly, text past 2^53 so no id ever collapses
      if (typeof raw === "number") {
        return Number.isSafeInteger(raw) ? raw : String(raw);
      }
      const text = String(raw);
      try {
        const asBig = BigInt(text);
        if (asBig <= MAX_SAFE && asBig >= -MAX_SAFE) return Number(asBig);
      } catch {}
      return text;
    }
    case "decimal":
    case "date":
    case "datetime":
    case "text":
      return String(raw);
    case "boolean":
      return Boolean(raw);
    case "text_array":
      // an array column crosses as its JSON-array text; the wire needs a real array, not a driver literal
      if (!Array.isArray(raw)) {
        throw new Error(`text_array expected a JS array, got ${JSON.stringify(raw)}`);
      }
      return JSON.stringify(raw);
  }
}
