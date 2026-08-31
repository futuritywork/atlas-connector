#!/usr/bin/env bun
// scaffold a new Atlas connector: copy templates/<kind> into <dir>, substitute the slug and port,
// pin the SDK semver, print next steps. `bun create atlas-connector <dir>` and
// `bunx create-atlas-connector <dir>` both land here; missing required answers fall back to prompts.

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
const KINDS = ["sql", "rest"] as const;
type Kind = (typeof KINDS)[number];

const USAGE = `create-atlas-connector — scaffold a Futurity Atlas external connector

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

// derive a legal atlas.json slug (^[a-z][a-z0-9-]{2,39}$) from the given name
function toSlug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const prefixed = /^[a-z]/.test(cleaned) ? cleaned : `c-${cleaned}`;
  const bounded = prefixed.slice(0, 40);
  return bounded.length >= 3 ? bounded : `${bounded}-connector`.slice(0, 40);
}

// rewrite a placeholder in every copied text file; template files are all UTF-8 text
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

// the stamped package.json pins the SDK at the semver this cli shipped with. from a checkout the
// sibling root IS the SDK; installed, the two packages release in lockstep, so own.version holds
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

let name = values.name ?? positionals[0];
let kind = values.kind as Kind | undefined;
let port = values.port ? Number(values.port) : undefined;

if (kind !== undefined && !KINDS.includes(kind)) {
  fail(`--kind must be one of: ${KINDS.join(", ")}`);
}
if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
  fail("--port must be an integer between 1 and 65535");
}

// scripted when both required answers arrived as args; otherwise walk name → kind → port
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
        options: [
          {
            value: "sql",
            label: "a sql database",
            hint: "extend SqlConnector: a catalog + one run(sql, params)",
          },
          {
            value: "rest",
            label: "a rest or erp api",
            hint: "extend AtlasConnector: five mandatory methods + an authored capability",
          },
        ],
      }),
    );
  }
  if (port === undefined) {
    const answer = unwrap(
      await p.text({
        message: "port",
        initialValue: String(PLACEHOLDER_PORT),
        validate: (value) => {
          const n = Number(value);
          return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : "1-65535";
        },
      }),
    );
    port = Number(answer);
  }
  p.outro("scaffolding");
}

if (!name || !kind) fail("--name and --kind are required");
port ??= PLACEHOLDER_PORT;

const dest = resolve(process.cwd(), positionals[0] ?? name);
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

const fillIn =
  kind === "sql"
    ? "declare your tables in src/catalog.ts, then connect your database in src/connector.ts run()"
    : "fill in the YOUR CODE HERE methods in src/connector.ts; earn each flag in src/capability.ts";

process.stdout.write(`Scaffolded '${slug}' (${kind}) at ${dest}\n\n`);
process.stdout.write("Next steps:\n");
process.stdout.write(`  cd ${positionals[0] ?? name}\n`);
process.stdout.write(
  "  cp .env.example .env    # set ATLAS_CONNECTOR_TOKEN to a 32+ char secret\n",
);
process.stdout.write("  bun install\n");
process.stdout.write(`  bun run start           # serves on :${port}\n\n`);
process.stdout.write(`Then ${fillIn}, and point atlas-conform at it to grade the result.\n`);
