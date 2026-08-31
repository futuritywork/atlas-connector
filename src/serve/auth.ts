import { createHash, timingSafeEqual } from "node:crypto";
import { unauthorized } from "./errors";

// hash first to equalize length, so timingSafeEqual never throws on a length mismatch
function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

// every data endpoint requires the bearer; nothing leaks without it
export function bearerGuard(token: string): (header: string | undefined) => void {
  const expected = digest(token);
  return (header) => {
    const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!presented) throw unauthorized("missing bearer token");
    if (!timingSafeEqual(digest(presented), expected)) {
      throw unauthorized("invalid bearer token");
    }
  };
}
