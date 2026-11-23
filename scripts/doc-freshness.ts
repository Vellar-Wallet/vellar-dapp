#!/usr/bin/env tsx
/**
 * Documentation freshness checks (#747, #749, #750).
 *
 * Hand-written docs drift silently. This script cross-checks the claims that
 * can be verified mechanically against the code/config that is the real source
 * of truth, and fails (exit 1) when they disagree:
 *
 *   1. API routes (#749): every route documented in apps/docs/api-reference.md
 *      must be registered (`app.get/post/...`) in the owning service's
 *      server.ts. Routes that exist in code but are undocumented are only
 *      reported as warnings.
 *   2. Version floors (#750): the Node/pnpm/Rust/stellar-cli floors in
 *      apps/docs/getting-started.md must match their sources of truth:
 *
 *        Node.js      root package.json            `engines.node`
 *        pnpm         root package.json            `packageManager`
 *        cargo        contracts/rust-toolchain.toml `channel`
 *        stellar-cli  infra/docker/verification-builder.Dockerfile `STELLAR_CLI_VERSION`
 *
 *      Rust and stellar-cli are not enforced by any engines-style field, so
 *      they are pinned to the toolchain file and the deterministic-build
 *      Dockerfile that the contracts are actually built with.
 *   3. Runnable commands (#747): fenced commands in the listed docs must not
 *      reference a script or file that no longer exists (e.g. the deleted
 *      load-test harness).
 *
 * Usage:
 *   tsx scripts/doc-freshness.ts        (from the repo root, or `pnpm check:docs`)
 *
 * Exit codes: 0 — all checks pass (warnings allowed); 1 — drift found.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Version floors (#750) ─────────────────────────────────────────────────

export interface Version {
  major: number;
  minor: number;
}

export interface DocumentedFloors {
  node?: Version;
  pnpm?: Version;
  cargo?: Version;
  stellar?: Version;
}

function toVersion(major: string | undefined, minor: string | undefined): Version | undefined {
  if (major === undefined) return undefined;
  return { major: Number(major), minor: minor === undefined ? 0 : Number(minor) };
}

const fmt = (v: Version) => `${v.major}.${v.minor}`;

/** The text of the `## Prerequisites` section (or the whole document if there is none). */
function prerequisitesSection(markdown: string): string {
  const start = /^##\s+Prerequisites\b.*$/m.exec(markdown);
  if (!start) return markdown;
  const rest = markdown.slice(start.index + start[0].length);
  const next = /^##\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/**
 * Reads the Node/pnpm/cargo/stellar floors from the "Prerequisites" table. Only
 * that section is read, so other tables that mention the same tools (such as
 * the "where the floors come from" table) cannot change the result.
 */
export function parseDocumentedFloors(markdown: string): DocumentedFloors {
  const floors: DocumentedFloors = {};
  for (const line of prerequisitesSection(markdown).split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const label = cells[0] ?? "";
    const version = cells[1] ?? "";

    if (/node/i.test(label)) {
      const m = /(\d+)(?:\.(\d+))?/.exec(version);
      floors.node = toVersion(m?.[1], m?.[2]) ?? floors.node;
    } else if (/pnpm/i.test(label)) {
      const m = /(\d+)(?:\.(\d+|x))?/.exec(version);
      floors.pnpm = toVersion(m?.[1], m?.[2] === "x" ? undefined : m?.[2]) ?? floors.pnpm;
    } else if (/rust|cargo|stellar/i.test(label)) {
      const cargo = /cargo\s+(\d+)\.(\d+)/i.exec(version);
      const stellar = /stellar\s+(\d+)(?:\.(\d+))?/i.exec(version);
      if (cargo) floors.cargo = toVersion(cargo[1], cargo[2]);
      if (stellar) floors.stellar = toVersion(stellar[1], stellar[2]);
    }
  }
  return floors;
}

/** `engines.node` such as ">=22" or ">=20.6.0" → its lower bound. */
export function parseNodeEngine(range: string | undefined): Version {
  const m = /^\s*>=\s*v?(\d+)(?:\.(\d+))?/.exec(range ?? "");
  const version = toVersion(m?.[1], m?.[2]);
  if (!version) {
    throw new Error(`package.json engines.node must be a ">=<version>" range, got "${range}"`);
  }
  return version;
}

/** `packageManager` such as "pnpm@11.9.0" → { major: 11, minor: 9 }. */
export function parsePackageManager(value: string | undefined): Version {
  const m = /^pnpm@(\d+)\.(\d+)/.exec(value ?? "");
  const version = toVersion(m?.[1], m?.[2]);
  if (!version) throw new Error(`package.json packageManager must be "pnpm@x.y.z", got "${value}"`);
  return version;
}

/** `channel = "1.94.0"` in rust-toolchain.toml → { major: 1, minor: 94 }. */
export function parseToolchainChannel(toml: string): Version {
  const m = /^\s*channel\s*=\s*"(\d+)\.(\d+)/m.exec(toml);
  const version = toVersion(m?.[1], m?.[2]);
  if (!version) throw new Error("contracts/rust-toolchain.toml has no numeric `channel`");
  return version;
}

/** `ARG STELLAR_CLI_VERSION=26.1.0` in the verification builder Dockerfile. */
export function parseStellarCliPin(dockerfile: string): Version {
  const m = /^\s*ARG\s+STELLAR_CLI_VERSION=(\d+)\.(\d+)/m.exec(dockerfile);
  const version = toVersion(m?.[1], m?.[2]);
  if (!version) throw new Error("verification-builder.Dockerfile has no STELLAR_CLI_VERSION pin");
  return version;
}

export interface VersionSources {
  node: Version;
  pnpm: Version;
  cargo: Version;
  stellar: Version;
}

/**
 * Compares documented floors with their sources of truth. Node and cargo must
 * match on major.minor; pnpm and stellar are documented by major ("11.x",
 * "26+"), so only the major must match.
 */
export function checkVersionFloors(docs: DocumentedFloors, sources: VersionSources): string[] {
  const problems: string[] = [];
  const need = (name: string, doc: Version | undefined, source: Version, majorOnly: boolean) => {
    if (!doc) {
      problems.push(`getting-started.md documents no ${name} version floor`);
      return;
    }
    const same = majorOnly
      ? doc.major === source.major
      : doc.major === source.major && doc.minor === source.minor;
    if (!same) {
      const shown = majorOnly ? `${source.major}` : fmt(source);
      const docShown = majorOnly ? `${doc.major}` : fmt(doc);
      problems.push(`${name}: docs say ${docShown}, source of truth says ${shown}`);
    }
  };
  need("Node.js", docs.node, sources.node, false);
  need("pnpm", docs.pnpm, sources.pnpm, true);
  need("cargo", docs.cargo, sources.cargo, false);
  need("stellar-cli", docs.stellar, sources.stellar, true);
  return problems;
}

// ── API routes (#749) ─────────────────────────────────────────────────────

export interface RouteRef {
  method: string;
  path: string;
}

export interface DocumentedRoute extends RouteRef {
  /** Owning service, from the enclosing "## … → xxx-service" heading. */
  service: string | undefined;
  line: number;
}

/** Path params are matched by position, not name (`:id` ≡ `:recordId`). */
export function normalizeRoutePath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
  return trimmed.replace(/:[A-Za-z0-9_]+/g, ":param");
}

const routeKey = (r: RouteRef) => `${r.method.toUpperCase()} ${normalizeRoutePath(r.path)}`;

/**
 * Routes documented as `### \`METHOD /path\`` headings. The service comes from
 * the nearest preceding `## … (\`/prefix/*\` → name-service)` heading.
 */
export function extractDocumentedRoutes(markdown: string): DocumentedRoute[] {
  const routes: DocumentedRoute[] = [];
  let service: string | undefined;
  markdown.split("\n").forEach((text, index) => {
    const section = /^##\s+.*→\s*([a-z][a-z0-9-]*-service)\b/.exec(text);
    if (section) service = section[1];
    else if (/^##\s/.test(text)) service = undefined;

    const route = /^###\s+`(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)`/.exec(text);
    if (route?.[1] && route[2]) {
      routes.push({ method: route[1], path: route[2], service, line: index + 1 });
    }
  });
  return routes;
}

/** Routes registered with `app.get("/x", …)`-style calls in a server source. */
export function extractCodeRoutes(source: string): RouteRef[] {
  const routes: RouteRef[] = [];
  const pattern = /\bapp\.(get|post|put|patch|delete|head|options)\(\s*["'`]([^"'`]+)["'`]/g;
  for (const m of source.matchAll(pattern)) {
    if (m[1] && m[2]) routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return routes;
}

export interface RouteCheckResult {
  /** Documented but not registered in the owning service — fails the check. */
  missing: string[];
  /** Registered in code but not documented — reported, never fails. */
  undocumented: string[];
}

export function checkRoutes(
  documented: readonly DocumentedRoute[],
  codeByService: Readonly<Record<string, readonly RouteRef[]>>,
): RouteCheckResult {
  const missing: string[] = [];
  for (const doc of documented) {
    if (!doc.service) {
      missing.push(`api-reference.md:${doc.line} ${doc.method} ${doc.path} is under no service`);
      continue;
    }
    const code = codeByService[doc.service];
    if (!code) {
      missing.push(
        `api-reference.md:${doc.line} ${doc.method} ${doc.path}: unknown ${doc.service}`,
      );
      continue;
    }
    const wanted = routeKey(doc);
    if (!code.some((r) => routeKey(r) === wanted)) {
      missing.push(
        `api-reference.md:${doc.line} ${doc.method} ${doc.path} is not registered in ${doc.service}`,
      );
    }
  }

  const documentedKeys = new Set(documented.map((d) => `${d.service}|${routeKey(d)}`));
  const undocumented: string[] = [];
  for (const [service, routes] of Object.entries(codeByService)) {
    for (const route of routes) {
      if (!documentedKeys.has(`${service}|${routeKey(route)}`)) {
        undocumented.push(`${service}: ${route.method} ${route.path}`);
      }
    }
  }
  return { missing, undocumented };
}

// ── Runnable commands (#747) ──────────────────────────────────────────────

/**
 * Finds commands inside fenced code blocks that point at something that does
 * not exist: `tsx <file>` / `npx tsx <file>` with a missing file, or
 * `pnpm <name>:<sub>` (a colon always means a package script) that no root
 * script defines.
 */
export function findBrokenCommands(
  markdown: string,
  rootScripts: ReadonlySet<string>,
  fileExists: (path: string) => boolean,
): string[] {
  const problems: string[] = [];
  let inFence = false;
  markdown.split("\n").forEach((text, index) => {
    if (/^\s*```/.test(text)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) return;
    const line = text.trim().replace(/^\$\s*/, "");

    const file = /^(?:npx\s+)?tsx\s+(\S+)/.exec(line)?.[1];
    if (file && !file.startsWith("-") && !fileExists(file)) {
      problems.push(`line ${index + 1}: \`${line}\` — ${file} does not exist`);
    }
    const script = /^pnpm\s+([a-z0-9-]+:[a-z0-9:-]+)/i.exec(line)?.[1];
    if (script && !rootScripts.has(script)) {
      problems.push(`line ${index + 1}: \`${line}\` — no root script "${script}"`);
    }
  });
  return problems;
}

// ── Repo wiring ───────────────────────────────────────────────────────────

export const DOCUMENTED_SERVICES = [
  "wallet-service",
  "lifecycle-service",
  "policy-service",
  "verification-service",
] as const;

/** Docs whose fenced commands must stay runnable. */
export const COMMAND_DOCS = ["docs/LOAD_TESTING.md"] as const;

export interface DocCheckReport {
  errors: string[];
  warnings: string[];
}

/** Runs every check against the repo at `root`. */
export function runDocChecks(root: string): DocCheckReport {
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  const errors: string[] = [];
  const warnings: string[] = [];

  // Version floors
  try {
    const pkg = JSON.parse(read("package.json")) as {
      engines?: { node?: string };
      packageManager?: string;
      scripts?: Record<string, string>;
    };
    const sources: VersionSources = {
      node: parseNodeEngine(pkg.engines?.node),
      pnpm: parsePackageManager(pkg.packageManager),
      cargo: parseToolchainChannel(read("contracts/rust-toolchain.toml")),
      stellar: parseStellarCliPin(read("infra/docker/verification-builder.Dockerfile")),
    };
    const floors = parseDocumentedFloors(read("apps/docs/getting-started.md"));
    errors.push(...checkVersionFloors(floors, sources).map((p) => `version floor — ${p}`));

    // Runnable commands
    const scripts = new Set(Object.keys(pkg.scripts ?? {}));
    for (const doc of COMMAND_DOCS) {
      const broken = findBrokenCommands(read(doc), scripts, (p) => existsSync(join(root, p)));
      errors.push(...broken.map((p) => `${doc} ${p}`));
    }
  } catch (err) {
    errors.push(`version floor — ${err instanceof Error ? err.message : String(err)}`);
  }

  // API routes
  const codeByService: Record<string, RouteRef[]> = {};
  for (const service of DOCUMENTED_SERVICES) {
    codeByService[service] = extractCodeRoutes(read(`services/${service}/src/server.ts`));
  }
  const documented = extractDocumentedRoutes(read("apps/docs/api-reference.md"));
  const result = checkRoutes(documented, codeByService);
  errors.push(...result.missing.map((m) => `api route — ${m}`));
  warnings.push(...result.undocumented.map((u) => `undocumented route — ${u}`));

  return { errors, warnings };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { errors, warnings } = runDocChecks(root);

  for (const w of warnings) console.warn(`warning: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(
      `\n✗ ${errors.length} documentation drift problem(s). Fix the docs (or the code).`,
    );
    process.exit(1);
  }
  console.log(`✓ Docs are consistent with the code (${warnings.length} warning(s)).`);
}

// Only run when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
