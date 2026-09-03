import type { DiscoveredField, DiscoveredTable } from "@futurity/atlas-connector";
import { EsbCoreError } from "../esb-api";
import type { EsbCoreObject } from "../types";

export const PROBE_CONCURRENCY = 4;

const TRANSIENT_STATUSES = new Set([408, 425, 429]);

type UnavailabilityReason = "permission" | "unavailable" | "rejected" | "incompatible";

export type AvailabilityVerdict =
  | { object: EsbCoreObject; accessible: true }
  | {
      object: EsbCoreObject;
      accessible: false;
      reason: UnavailabilityReason;
      status: number;
      code: string;
    };

export function isOmittableDiscoveryError(error: unknown): error is EsbCoreError & { status: number } {
  if (!(error instanceof EsbCoreError) || error.credentialFailure || error.failureKind === "authentication") {
    return false;
  }
  const status = error.status;
  if (status === undefined) return false;
  if (error.failureKind === "permission") return true;
  if (error.applicationFailure || TRANSIENT_STATUSES.has(status) || status >= 500) return false;
  const incompatible = error.code === "malformed-response" || error.code === "non-progressing-page";
  return (incompatible && status >= 200 && status < 300) || (status >= 400 && status < 500);
}

export function toInaccessibleVerdict(
  object: EsbCoreObject,
  error: EsbCoreError & { status: number },
): AvailabilityVerdict {
  const incompatible = error.code === "malformed-response" || error.code === "non-progressing-page";
  let reason: UnavailabilityReason = "rejected";
  if (incompatible) reason = "incompatible";
  else if (error.failureKind === "permission" || error.status === 403) reason = "permission";
  else if (error.status === 404) reason = "unavailable";
  return {
    object,
    accessible: false,
    reason,
    status: error.status,
    code: error.code,
  };
}

export function discoveryWarning(verdict: AvailabilityVerdict): string | null {
  if (verdict.accessible) return null;
  return verdict.reason === "incompatible"
    ? `ESB Core ${verdict.object.name} (${verdict.object.path}) was omitted: response format is not supported by Atlas`
    : `ESB Core ${verdict.object.name} (${verdict.object.path}) was omitted: HTTP ${verdict.status}, code ${verdict.code}`;
}

export async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await visit(values[index] as T);
    }
  });
  await Promise.all(workers);
}

export function toDiscoveredTable(object: EsbCoreObject): DiscoveredTable {
  const fields: DiscoveredField[] = object.columns.map((column) => ({
    name: column.name,
    sourceColumn: column.name,
    type: column.type,
    nullable: column.nullable,
    unique: object.primaryKey === column.name,
    samples: [],
    sourceDescription: column.description,
  }));
  return {
    name: object.name,
    sourceDescription: object.description,
    storesRows: true,
    primaryKey: object.primaryKey ? [object.primaryKey] : [],
    foreignKeys: [],
    fields,
  };
}
