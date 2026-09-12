import { discoverFields, type DiscoveredTable } from "@futurity/atlas-connector";
import { EsbCoreError } from "../esb-api";
import type { EsbCoreObject } from "../types";

export const PROBE_CONCURRENCY = 4;

const TRANSIENT_STATUSES = new Set([408, 425, 429]);
const INCOMPATIBLE_CODES = new Set(["malformed-response", "non-progressing-page"]);

type UnavailabilityReason = "permission" | "unavailable" | "rejected" | "incompatible";

export type AvailabilityVerdict =
  | { object: EsbCoreObject; accessible: true; rowCount?: number }
  | {
      object: EsbCoreObject;
      accessible: false;
      reason: UnavailabilityReason;
      status: number;
      code: string;
    };

// a credential failure ends the run
export function isEndpointFailure(error: unknown): error is EsbCoreError {
  return error instanceof EsbCoreError && !error.credentialFailure && error.failureKind !== "authentication";
}

export function isOmittableDiscoveryError(error: unknown): error is EsbCoreError & { status: number } {
  if (!isEndpointFailure(error)) return false;
  const status = error.status;
  if (status === undefined) return false;
  if (error.failureKind === "permission") return true;
  if (error.applicationFailure || TRANSIENT_STATUSES.has(status) || status >= 500) return false;
  const incompatible = INCOMPATIBLE_CODES.has(error.code);
  return (incompatible && status >= 200 && status < 300) || (status >= 400 && status < 500);
}

function unavailabilityReason(error: EsbCoreError & { status: number }): UnavailabilityReason {
  if (INCOMPATIBLE_CODES.has(error.code)) return "incompatible";
  if (error.failureKind === "permission" || error.status === 403) return "permission";
  if (error.status === 404) return "unavailable";
  return "rejected";
}

export function toInaccessibleVerdict(
  object: EsbCoreObject,
  error: EsbCoreError & { status: number },
): AvailabilityVerdict {
  return {
    object,
    accessible: false,
    reason: unavailabilityReason(error),
    status: error.status,
    code: error.code,
  };
}

export function discoveryWarning(verdict: AvailabilityVerdict): string | null {
  if (verdict.accessible) return null;
  const collection = `ESB Core ${verdict.object.name} (${verdict.object.path})`;
  if (verdict.reason === "incompatible") {
    return `${collection} was omitted: response format is not supported by Atlas`;
  }
  return `${collection} was omitted: HTTP ${verdict.status}, code ${verdict.code}`;
}

export async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  // one shared iterator hands each value out once
  const remaining = values[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (const value of remaining) await visit(value);
  });
  await Promise.all(workers);
}

export function toDiscoveredTable(object: EsbCoreObject, rowCount?: number): DiscoveredTable {
  return {
    name: object.name,
    sourceDescription: object.description,
    ...(rowCount === undefined ? {} : { rowCount }),
    storesRows: true,
    primaryKey: object.primaryKey ? [object.primaryKey] : [],
    foreignKeys: [],
    fields: discoverFields(object.columns),
  };
}
