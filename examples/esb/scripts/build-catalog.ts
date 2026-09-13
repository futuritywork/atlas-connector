import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { AtlasType } from "@futurity/atlas-connector";
import {
  COLUMN_OVERRIDES,
  ENTITY_SELECTION,
  NULLABILITY_POLICY,
} from "../catalog-data/overrides";
import type { EsbCoreObject } from "../src/types";
import { assertEsbCoreCatalog } from "../src/catalog-validation";

const sourcePath = new URL("../catalog-data/api_data.json", import.meta.url);
const outputPath = new URL("../src/catalog.ts", import.meta.url);
const sourceUrl = "https://developers.esb.co.id/esb-core/api_data.json";

type JsonObject = Record<string, unknown>;
type SourceField = {
  field: string;
  type: string;
  optional: boolean;
  description: string;
};

function object(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${context}: expected an object`);
  return value as JsonObject;
}

function plainDescription(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi,
      (_, decimal: string, hex: string, named: string) => {
        if (decimal) return String.fromCodePoint(Number(decimal));
        if (hex) return String.fromCodePoint(parseInt(hex, 16));
        return entities[named.toLowerCase()]!;
      },
    )
    .replace(/\s+/g, " ")
    .trim();
}

function atlasType(type: string, context: string): AtlasType {
  switch (type.toLowerCase()) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    default:
      if (/^decimal(?:\(\d+[.,]\d+\))?$/i.test(type)) return "decimal";
      throw new Error(`${context}: unknown upstream type '${type}'`);
  }
}

function responseFields(endpoint: JsonObject, context: string): SourceField[] {
  const success = object(endpoint.success, `${context}.success`);
  const groups = object(success.fields, `${context}.success.fields`);
  return Object.values(groups).flatMap((group) => {
    if (!Array.isArray(group))
      throw new Error(`${context}: expected response field arrays`);
    return group.map((value) => {
      const field = object(value, `${context}.field`);
      if (
        typeof field.field !== "string" ||
        typeof field.type !== "string" ||
        typeof field.optional !== "boolean" ||
        typeof field.description !== "string"
      ) {
        throw new Error(`${context}: invalid response field contract`);
      }
      return {
        field: field.field,
        type: field.type,
        optional: field.optional,
        description: field.description,
      };
    });
  });
}

export function buildCatalog(data: unknown): EsbCoreObject[] {
  if (!Array.isArray(data))
    throw new Error("api_data.json: expected an array of endpoints");
  const endpoints = data.map((entry) =>
    object(entry, "api_data.json endpoint"),
  );
  for (const [name, overrides] of Object.entries(COLUMN_OVERRIDES)) {
    const selected = ENTITY_SELECTION.find((entry) => entry.name === name);
    if (!selected)
      throw new Error(`Override refers to unselected entity '${name}'`);
    for (const column of Object.keys(overrides)) {
      if (!selected.columns.includes(column))
        throw new Error(
          `Override refers to unselected field '${name}.${column}'`,
        );
    }
  }
  const catalog = ENTITY_SELECTION.map((selection) => {
    const matches = endpoints.filter(
      (entry) =>
        entry.type === "get" && entry.url === `{{base_url}}${selection.path}`,
    );
    if (matches.length !== 1)
      throw new Error(
        `${selection.name}: expected one GET endpoint for '${selection.path}', found ${matches.length}`,
      );
    const endpoint = matches[0]!;
    if (endpoint.version !== selection.version)
      throw new Error(
        `${selection.name}: upstream version changed from '${selection.version}'`,
      );
    const fields = responseFields(endpoint, selection.name);
    const prefix = selection.mode === "paged" ? "result.data." : "result.";
    return {
      name: selection.name,
      path: selection.path,
      description: selection.description,
      mode: selection.mode,
      ...(selection.primaryKey
        ? { primaryKey: selection.primaryKey.name }
        : {}),
      columns: selection.columns.map((name) => {
        const context = `${selection.name}.${name}`;
        const override = COLUMN_OVERRIDES[selection.name]?.[name];
        const fieldPath = override?.sourceField ?? `${prefix}${name}`;
        const matches = fields.filter((field) => field.field === fieldPath);
        if (matches.length !== 1)
          throw new Error(
            `${context}: expected one response field '${fieldPath}', found ${matches.length}`,
          );
        const field = matches[0]!;
        const description = plainDescription(field.description);
        if (override?.type && override.type.from !== field.type)
          throw new Error(
            `${context}: stale type override; expected '${override.type.from}', received '${field.type}'`,
          );
        if (override?.description && override.description.from !== description)
          throw new Error(
            `${context}: stale description override; upstream text changed`,
          );
        return {
          name,
          type: override?.type?.to ?? atlasType(field.type, context),
          nullable:
            name === selection.primaryKey?.name
              ? false
              : NULLABILITY_POLICY.nonPrimaryKey,
          description: override?.description?.to ?? description,
        };
      }),
    };
  });
  assertEsbCoreCatalog(catalog);
  return catalog;
}

export function renderCatalog(source: string): string {
  const catalog = buildCatalog(JSON.parse(source));
  const hash = createHash("sha256").update(source).digest("hex");
  const data = JSON.stringify(catalog, null, 2).replace(
    /^(\s*)"([A-Za-z_]\w*)": /gm,
    "$1$2: ",
  );
  return `// Generated by scripts/build-catalog.ts. Do not edit by hand.
// Source: ${sourceUrl}
// Source SHA-256: ${hash}
import type { EsbCoreObject } from "./types";
import { assertEsbCoreCatalog } from "./catalog-validation";

export const ESB_CORE_CATALOG: EsbCoreObject[] = ${data};

export function validateEsbCoreCatalog(catalog: EsbCoreObject[] = ESB_CORE_CATALOG): void {
  assertEsbCoreCatalog(catalog);
}

validateEsbCoreCatalog();
`;
}

async function main(args: string[]): Promise<void> {
  let input: URL = sourcePath;
  let output: URL = outputPath;
  let check = false;
  while (args.length) {
    const argument = args.shift();
    if (argument === "--check") check = true;
    else if (argument === "--input" || argument === "--output") {
      const value = args.shift();
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a file path`);
      if (argument === "--input") input = pathToFileURL(value);
      else output = pathToFileURL(value);
    } else throw new Error(`Unknown argument '${argument}'`);
  }
  const rendered = renderCatalog(await readFile(input, "utf8"));
  if (check) {
    if ((await readFile(output, "utf8")) !== rendered)
      throw new Error(
        "ESB catalog is out of date. Review the input and overrides, then run catalog:generate.",
      );
    console.log("ESB catalog matches its pinned source and overrides.");
  } else {
    await writeFile(output, rendered);
    console.log(`Generated ${output.pathname}`);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
