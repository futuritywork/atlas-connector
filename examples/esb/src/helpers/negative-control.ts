// ESB answers 200 for unknown params

import type { Credentials } from "@futurity/atlas-connector";
import { EsbCoreApi, type Deadline } from "../esb-api";
import type { EsbCoreObject, EsbFilterParam } from "../types";
import { parseCredentials, tokenCacheKey } from "./api";
import { isEndpointFailure, mapConcurrent, type AvailabilityVerdict } from "./discovery";
import { paramKey, paramLabel, type HonoredParams } from "./pushdown";

const CONTROL_TEXT = "ATLASNEGATIVECONTROL0"; // alphanumeric: several params are bound required,alphanum
const CONTROL_NUMBER = "987654321";
const CONTROL_SET = "987654321,987654322"; // several endpoints answer 500 to a comma set
const CONTROL_FROM = "1900-01-01";
const CONTROL_TO = "1900-12-31";

type IgnoredFilter = { key: string; warning: string };

type Control = { object: EsbCoreObject; entry: EsbFilterParam; rowCount: number };

const honoredByTenant = new Map<string, ReadonlySet<string>>();

function controlValues(object: EsbCoreObject, entry: EsbFilterParam): Record<string, string> {
  if (!("param" in entry)) return { [entry.from]: CONTROL_FROM, [entry.to]: CONTROL_TO };
  if (entry.ops.includes("in")) return { [entry.param]: CONTROL_SET };
  const type = object.columns.find((column) => column.name === entry.field)?.type;
  if (type === "number" || type === "decimal") return { [entry.param]: CONTROL_NUMBER };
  if (type === "date" || type === "datetime") return { [entry.param]: CONTROL_FROM };
  return { [entry.param]: CONTROL_TEXT };
}

async function isHonored(
  api: EsbCoreApi,
  object: EsbCoreObject,
  entry: EsbFilterParam,
  rowCount: number,
  deadline: Deadline,
): Promise<boolean> {
  try {
    const head = await api.collection(
      object,
      { page: 1, limit: 1, params: controlValues(object, entry), fields: [] },
      deadline,
    );
    return (head.count ?? rowCount) < rowCount;
  } catch (error) {
    if (!isEndpointFailure(error)) throw error;
    const status = error.status;
    // 4xx proves the endpoint read the value; 5xx does not
    return error.failureKind === undefined && status !== undefined && status >= 400 && status < 500;
  }
}

function controlsFor(available: AvailabilityVerdict[]): Control[] {
  const controls: Control[] = [];
  for (const verdict of available) {
    // an empty collection cannot narrow
    if (!verdict.accessible || !verdict.rowCount) continue;
    for (const entry of verdict.object.filters ?? []) {
      controls.push({ object: verdict.object, entry, rowCount: verdict.rowCount });
    }
  }
  return controls;
}

export async function controlFilters(
  api: EsbCoreApi,
  available: AvailabilityVerdict[],
  concurrency: number,
  deadline: Deadline,
): Promise<IgnoredFilter[]> {
  const ignored: IgnoredFilter[] = [];
  await mapConcurrent(controlsFor(available), concurrency, async ({ object, entry, rowCount }) => {
    if (await isHonored(api, object, entry, rowCount, deadline)) return;
    ignored.push({
      key: paramKey(object, entry),
      warning: `ESB Core ${object.name} (${object.path}) ignores the ${paramLabel(entry)} filter; Atlas filters ${entry.field} itself`,
    });
  });
  return ignored;
}

export function honoredFilters(credentials: Credentials): HonoredParams {
  return honoredByTenant.get(tokenCacheKey(parseCredentials(credentials)));
}

export function rememberHonoredFilters(
  credentials: Credentials,
  available: AvailabilityVerdict[],
  ignored: IgnoredFilter[],
): void {
  const keys = new Set<string>();
  for (const verdict of available) {
    for (const entry of verdict.object.filters ?? []) keys.add(paramKey(verdict.object, entry));
  }
  for (const entry of ignored) keys.delete(entry.key);
  honoredByTenant.set(tokenCacheKey(parseCredentials(credentials)), keys);
}

export function resetHonoredFiltersForTests(): void {
  honoredByTenant.clear();
}
