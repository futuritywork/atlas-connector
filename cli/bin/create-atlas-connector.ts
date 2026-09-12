#!/usr/bin/env bun
// scaffold a connector: copy templates/<kind>, substitute the slug and port, pin the SDK semver
// --name and --kind as args runs unattended; a missing one prompts

import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";

const PLACEHOLDER = "my-atlas-connector";
const PLACEHOLDER_PORT = 4100;
const SLUG_MAX = 40; // an atlas.json slug is ^[a-z][a-z0-9-]{2,39}$

const KINDS = ["sql", "rest"] as const;
type Kind = (typeof KINDS)[number];

const CHOICES: Record<Kind, { label: string; hint: string }> = {
  sql: { label: "a sql database", hint: "extend SqlConnector: a catalog + openPool/run" },
  rest: {
    label: "a rest or erp api",
    hint: "extend AtlasConnector: check/query/count/discovery + an authored capability",
  },
};

const NEXT_STEP: Record<Kind, string> = {
  sql: "declare your tables in src/catalog.ts; src/connector.ts already opens a postgres pool from the tenant's databaseUrl",
  rest: "fill in the YOUR CODE HERE methods in src/connector.ts; earn each flag in src/capability.ts",
};

const USAGE = `create-atlas-connector: scaffold a Futurity Atlas external connector

Usage: create-atlas-connector [dir] [options]

Options:
  --name <string>       connector name; becomes the slug (default: dir basename)
  --kind <sql|rest>     what backs the source: a sql database, or a rest/erp api
  --port <number>       port stamped into .env.example (default: ${PLACEHOLDER_PORT})
  -h, --help            show this help

Missing --name/--kind fall back to interactive prompts.

Examples:
  create-atlas-connector my-crm --kind sql
  create-atlas-connector anaplan-bridge --kind rest --port 4200
`;

function isKind(value: string): value is Kind {
  return KINDS.some((kind) => kind === value);
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function toSlug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const prefixed = /^[a-z]/.test(cleaned) ? cleaned : `c-${cleaned}`;
  const bounded = prefixed.slice(0, SLUG_MAX);
  return bounded.length >= 3 ? bounded : `${bounded}-connector`.slice(0, SLUG_MAX);
}

// rewrite a placeholder in every copied file; templates are all utf-8 text
function substitute(dir: string, from: string, to: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      substitute(full, from, to);
      continue;
    }
    const before = readFileSync(full, "utf8");
    const after = before.split(from).join(to);
    if (after !== before) writeFileSync(full, after);
  }
}

// the cli and the SDK release in lockstep, so the cli's own version pins it; a sibling checkout wins
function pinSdkVersion(dest: string): void {
  const own = JSON.parse(
    readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8"),
  ) as { version: string };
  let range = `^${own.version}`;
  const siblingPath = resolve(import.meta.dir, "..", "..", "package.json");
  if (existsSync(siblingPath)) {
    const sibling = JSON.parse(readFileSync(siblingPath, "utf8")) as {
      name?: string;
      version?: string;
    };
    if (sibling.name === "@futurity/atlas-connector" && sibling.version) {
      range = `^${sibling.version}`;
    }
  }
  const stampPath = join(dest, "package.json");
  const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  stamp.dependencies["@futurity/atlas-connector"] = range;
  writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`create-atlas-connector: ${message}\n`);
  process.exit(1);
}

function unwrap<T>(answer: T | symbol): T {
  if (p.isCancel(answer)) {
    p.cancel("cancelled");
    process.exit(1);
  }
  return answer as T;
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    name: { type: "string" },
    kind: { type: "string" },
    port: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const dir = positionals[0];
let name = values.name ?? (dir ? basename(dir) : undefined);
let port = values.port ? Number(values.port) : undefined;

if (values.kind !== undefined && !isKind(values.kind)) {
  fail(`--kind must be one of: ${KINDS.join(", ")}`);
}
let kind: Kind | undefined = values.kind;

if (port !== undefined && !isPort(port)) {
  fail("--port must be an integer between 1 and 65535");
}

if (!name || !kind) {
  p.intro("create-atlas-connector");
  if (!name) {
    name = unwrap(
      await p.text({
        message: "name your connector",
        placeholder: PLACEHOLDER,
        validate: (value) => (!value || value.trim() === "" ? "a name is required" : undefined),
      }),
    );
  }
  if (!kind) {
    kind = unwrap(
      await p.select<Kind>({
        message: "what backs this source?",
        options: KINDS.map((value) => ({ value, ...CHOICES[value] })),
      }),
    );
  }
  if (port === undefined) {
    const answer = unwrap(
      await p.text({
        message: "port",
        initialValue: String(PLACEHOLDER_PORT),
        validate: (value) => (isPort(Number(value)) ? undefined : "1-65535"),
      }),
    );
    port = Number(answer);
  }
  p.outro("scaffolding");
}

port ??= PLACEHOLDER_PORT;

const target = dir ?? name;
const dest = resolve(process.cwd(), target);
if (existsSync(dest) && readdirSync(dest).length > 0) {
  fail(`${dest} already exists and is not empty`);
}

const templateDir = resolve(import.meta.dir, "..", "templates", kind);
if (!existsSync(templateDir)) fail(`template missing: ${templateDir}`);

const slug = toSlug(name);

cpSync(templateDir, dest, { recursive: true });
substitute(dest, PLACEHOLDER, slug);
if (port !== PLACEHOLDER_PORT) {
  substitute(dest, `CONNECTOR_PORT=${PLACEHOLDER_PORT}`, `CONNECTOR_PORT=${port}`);
}
pinSdkVersion(dest);

process.stdout.write(`Scaffolded '${slug}' (${kind}) at ${dest}

Next steps:
  cd ${target}
  cp .env.example .env    # set ATLAS_CONNECTOR_TOKEN to a 32+ char secret
  bun install
  bun run start           # serves on :${port}

Then ${NEXT_STEP[kind]}, and point atlas-conform at it to grade the result.
`);
