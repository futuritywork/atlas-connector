import type { z } from "zod";
import { badRequest, timeout } from "./errors";

// malformed body → 400 with the envelope, never Elysia's default 422 (which we reserve for
// "legal Atlas request the capability document never advertised")
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw badRequest(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return result.data;
}

// races the work against the request's own timeoutMs; whichever fires first, the caller's
// deadline is honored server-side (Atlas keeps its own regardless)
export async function withTimeout<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeout(`request exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
