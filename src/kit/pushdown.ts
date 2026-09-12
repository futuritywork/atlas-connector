// the one place a connector says what it sends upstream; the capability doc is emitted from it

import type { CapabilityDoc, SourceCapabilitiesWire } from "../wire/atlas-json";
import type { Op } from "../wire/vocabulary";

/** the ops one entity pushes, whole-entity or per field. */
export type EntityPushdown = {
  ops?: readonly Op[];
  fields?: Record<string, readonly Op[]>;
};

/** what a connector pushes upstream, source-wide or narrowed per entity. */
export type Pushdown = {
  ops?: readonly Op[];
  entities?: Record<string, EntityPushdown>;
  sort?: "none" | "single" | "multi";
  offset?: boolean;
  join?: boolean; // only when query() hands the upstream a join
};

type CapabilityInput = Pick<CapabilityDoc, "slug" | "dialect" | "credentialSchema"> &
  Pick<SourceCapabilitiesWire, "dateBucket" | "keysEnforced" | "limits"> & { pushdown: Pushdown };

/** the ops an entity or one of its fields pushes; the narrowest declaration wins. */
export function pushedOps(pushdown: Pushdown, entity: string, field?: string): Set<Op> {
  const entry = pushdown.entities?.[entity];
  const perField = field === undefined ? undefined : entry?.fields?.[field];
  return new Set(perField ?? entry?.ops ?? pushdown.ops ?? []);
}

// the advertised set is source-wide, so flatten every entity and field into one
function everyPushedOp(pushdown: Pushdown): Op[] {
  const ops = new Set<Op>(pushdown.ops ?? []);
  for (const entity of Object.values(pushdown.entities ?? {})) {
    for (const op of entity.ops ?? []) ops.add(op);
    for (const fieldOps of Object.values(entity.fields ?? {})) {
      for (const op of fieldOps) ops.add(op);
    }
  }
  return [...ops];
}

/** the query half of a capability doc, read off the pushdown map. */
export function pushdownCapabilities(
  pushdown: Pushdown,
): Pick<SourceCapabilitiesWire, "operators" | "sort" | "offset" | "join"> {
  return {
    operators: everyPushedOp(pushdown),
    sort: pushdown.sort ?? "none",
    offset: pushdown.offset ?? false,
    join: pushdown.join ?? false,
  };
}

/** the whole capability doc: the pushdown map emits the query half, the rest are vendor facts. */
export function defineCapability(input: CapabilityInput): CapabilityDoc {
  return {
    protocolVersion: 1,
    slug: input.slug,
    ...(input.dialect === undefined ? {} : { dialect: input.dialect }),
    capabilities: {
      ...pushdownCapabilities(input.pushdown),
      dateBucket: input.dateBucket,
      keysEnforced: input.keysEnforced,
      limits: input.limits,
    },
    credentialSchema: input.credentialSchema,
  };
}
