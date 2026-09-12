import { z } from "zod";
import { CONNECTOR_LIMITS } from "./limits";
import { Op } from "./vocabulary";

export const ATLAS_JSON_PATH = "/.well-known/futurity/atlas.json";

export const ATLAS_JSON_MAX_BYTES = CONNECTOR_LIMITS.docBytes;

// the optional protocol methods; overriding one adds its route and its entry here
export const CONNECTOR_ENDPOINTS = ["size", "count", "aggregate", "cardinality", "linkHitRate"] as const;
export type ConnectorEndpoint = (typeof CONNECTOR_ENDPOINTS)[number];

// vendor ceilings; atlas plans its pulls against them
export const ConnectorLimitsWire = z
  .object({
    pageSizeMax: z.number().int().min(1).optional(), // absent when the vendor sets no page ceiling
    rowsPerTableMax: z.number().int().min(1).optional(),
    concurrency: z.number().int().min(1).max(16), // a cursor api is 1
    offsetMax: z.number().int().min(0).optional(),
  })
  .strict();
export type ConnectorLimits = z.infer<typeof ConnectorLimitsWire>;

export const SourceCapabilitiesWire = z
  .object({
    operators: z.array(Op), // emitted from the pushdown; [] pushes nothing
    dateBucket: z.boolean(),
    sort: z.enum(["none", "single", "multi"]),
    offset: z.boolean(),
    join: z.boolean(),
    keysEnforced: z.boolean(), // true only when the upstream itself rejects a duplicate
    limits: ConnectorLimitsWire,
  })
  .strict();
export type SourceCapabilitiesWire = z.infer<typeof SourceCapabilitiesWire>;

// one input the tenant types to reach their own upstream
export const CredentialFieldWire = z
  .object({
    key: z.string(),
    label: z.string(),
    type: z.enum(["text", "password", "textarea"]), // textarea for a pasted pem or key blob
    required: z.boolean().default(true), // a blank is omitted from credentials
    placeholder: z.string().optional(),
    help: z.string().optional(), // markdown under the label
  })
  .strict();
export type CredentialField = z.infer<typeof CredentialFieldWire>;

// not .strict(): unknown top-level fields are stripped for forward compat
export const AtlasJson = z.object({
  protocolVersion: z.literal(1),
  slug: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
  dialect: z.string().optional(), // open string: the consuming side narrows it to its own dialect set
  capabilities: SourceCapabilitiesWire,
  credentialSchema: z.array(CredentialFieldWire), // [] only when the source needs no per-tenant secret
  endpoints: z.array(z.enum(CONNECTOR_ENDPOINTS)),
});
export type AtlasJson = z.infer<typeof AtlasJson>;

/** what a connector declares; the SDK fills `endpoints` from the methods it overrides. */
export type CapabilityDoc = Omit<AtlasJson, "endpoints">;
