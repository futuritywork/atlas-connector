import { z } from "zod";
import { CONNECTOR_LIMITS } from "./limits";
import { Op } from "./vocabulary";

export const ATLAS_JSON_PATH = "/.well-known/futurity/atlas.json";

export const ATLAS_JSON_MAX_BYTES = CONNECTOR_LIMITS.docBytes;

const CONNECTOR_SORTS = ["none", "single", "multi"] as const;

export const SourceCapabilitiesWire = z
  .object({
    operators: z.array(Op).min(1),
    dateBucket: z.boolean(),
    sort: z.enum(CONNECTOR_SORTS),
    offset: z.boolean(),
    maxOffset: z.number().int().min(0).optional(),
    count: z.enum(["server", "scan", "none"]),
    join: z.boolean(),
    enforcesDeclaredKeys: z.boolean(),
    probeConcurrency: z.number().int().min(1).max(8),
    cheapProbes: z.boolean(),
  })
  .strict();
export type SourceCapabilitiesWire = z.infer<typeof SourceCapabilitiesWire>;

// not .strict(): unknown top-level fields are stripped for forward compat.
// dialect stays an open string; the consuming side narrows it to its dialect
// set and layers slug-collision + dialect-operator refinements on top
export const AtlasJson = z.object({
  protocolVersion: z.literal(1),
  slug: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
  dialect: z.string().optional(),
  capabilities: SourceCapabilitiesWire,
  endpoints: z.array(z.enum(["aggregate"])),
});
export type AtlasJson = z.infer<typeof AtlasJson>;
