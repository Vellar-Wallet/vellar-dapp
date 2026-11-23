#!/usr/bin/env tsx
/**
 * Runbook freshness checks (#751, #752).
 *
 * A runbook is read during an incident, which is the worst time to discover a
 * step names a file, key, flag or log line that no longer exists. This script
 * turns the references in `docs/runbooks/*.md` into a CI check:
 *
 *   1. Every backticked repo file path in the runbook must exist (paths that
 *      are listed in `.gitignore`, such as the private `docs/decisions.md`,
 *      cannot be checked in CI and are reported as warnings instead).
 *   2. Every fenced `tsx <script> --flag` command must point at a real script
 *      that still handles each `--flag` (`--flag` appears in its source).
 *   3. Every backticked ENV_KEY the runbook names must be declared in
 *      `render.yaml` (or be listed as intentionally external).
 *   4. Each runbook has a table of grep-style assertions about the code
 *      behind its steps (function X is called in file Y, service Z does NOT
 *      use key K, ...). Every assertion also names the text it comes from and
 *      is flagged when the runbook no longer mentions that text, so the table
 *      cannot quietly outlive the step it was written for.
 *
 * A failure names the runbook, the stale reference and what is wrong with it.
 *
 * Usage: `pnpm check:runbooks` (or `tsx scripts/runbook-freshness.ts`).
 * Exit codes: 0 — all runbooks match the code (warnings allowed); 1 — stale.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Extraction ────────────────────────────────────────────────────────────

/** Single-line inline code spans (`like this`); fenced blocks are not spans. */
export function extractCodeSpans(markdown: string): string[] {
  const spans: string[] = [];
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    if (match[1]) spans.push(match[1].trim());
  }
  return spans;
}

// Needs at least one "/": a bare name like `x402-client.ts` is a file in another
// repository (or a private doc), not something this repo can be asked to contain.
const FILE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@-]+)+\.(?:ts|tsx|md|yaml|yml|json)$/;

/** Backticked tokens that look like repo-relative file paths, de-duplicated. */
export function extractFilePaths(markdown: string): string[] {
  const paths = extractCodeSpans(markdown).filter((span) => FILE_PATH.test(span));
  return [...new Set(paths)];
}

const ENV_KEY = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Backticked UPPER_SNAKE_CASE tokens (environment variables), de-duplicated. */
export function extractEnvKeys(markdown: string): string[] {
  const keys = extractCodeSpans(markdown).filter((span) => ENV_KEY.test(span));
  return [...new Set(keys)];
}

export interface FencedScriptCall {
  script: string;
  flags: string[];
  line: number;
}

/** Fenced `tsx <script> --flag ...` commands (also `npx tsx`). */
export function extractScriptCalls(markdown: string): FencedScriptCall[] {
  const calls: FencedScriptCall[] = [];
  let inFence = false;
  markdown.split("\n").forEach((text, index) => {
    if (/^\s*```/.test(text)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) return;
    const match = /^\s*(?:\$\s*)?(?:npx\s+)?tsx\s+(\S+)(.*)$/.exec(text);
    if (!match?.[1]) return;
    const flags = [...(match[2] ?? "").matchAll(/(--[a-z][a-z0-9-]*)/gi)].map((m) => m[1]!);
    calls.push({ script: match[1], flags, line: index + 1 });
  });
  return calls;
}

// ── Checking ──────────────────────────────────────────────────────────────

/** A grep-style claim about the code behind a runbook step. */
export interface RunbookAssertion {
  /** Text in the runbook this assertion backs (must still appear there). */
  reference: string;
  /** Repo-relative file the claim is about. */
  file: string;
  /** Must match (default) or must NOT match (`absent: true`) in `file`. */
  pattern: RegExp;
  absent?: boolean;
  /** One line shown in the failure message: what the runbook relies on. */
  claim: string;
}

export interface RunbookSpec {
  path: string;
  assertions: readonly RunbookAssertion[];
  /** ENV_KEYs the runbook names that are NOT declared in render.yaml. */
  externalEnvKeys?: readonly string[];
}

export interface RepoReader {
  exists(path: string): boolean;
  read(path: string): string;
  /** Paths listed in .gitignore (exact lines), which CI cannot see. */
  gitignored: ReadonlySet<string>;
}

export interface RunbookReport {
  errors: string[];
  warnings: string[];
}

const stale = (runbook: string, message: string) => `${runbook}: ${message}`;

/** Collapses whitespace so a reference still matches when the runbook wraps it. */
const normalize = (text: string) => text.replace(/\s+/g, " ");

export function checkRunbook(spec: RunbookSpec, repo: RepoReader): RunbookReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = spec.path;
  const markdown = repo.read(spec.path);
  const flat = normalize(markdown);

  // 1. File paths
  for (const path of extractFilePaths(markdown)) {
    if (repo.exists(path)) continue;
    if (repo.gitignored.has(path)) {
      warnings.push(stale(name, `\`${path}\` is gitignored, so it cannot be verified in CI`));
    } else {
      errors.push(stale(name, `references \`${path}\`, which no longer exists`));
    }
  }

  // 2. Fenced script commands, and the flags they pass
  for (const call of extractScriptCalls(markdown)) {
    if (!repo.exists(call.script)) {
      errors.push(
        stale(name, `line ${call.line}: command runs ${call.script}, which does not exist`),
      );
      continue;
    }
    const source = repo.read(call.script);
    for (const flag of call.flags) {
      if (!source.includes(`"${flag}"`)) {
        errors.push(
          stale(name, `line ${call.line}: ${call.script} no longer handles the ${flag} flag`),
        );
      }
    }
  }

  // 3. Environment keys must be declared in render.yaml
  const blueprint = repo.exists("render.yaml") ? repo.read("render.yaml") : "";
  const external = new Set(spec.externalEnvKeys ?? []);
  for (const key of extractEnvKeys(markdown)) {
    if (external.has(key)) continue;
    if (!new RegExp(`\\b${key}\\b`).test(blueprint)) {
      errors.push(stale(name, `names \`${key}\`, which render.yaml does not declare`));
    }
  }

  // 4. Code assertions
  for (const assertion of spec.assertions) {
    if (!flat.includes(normalize(assertion.reference))) {
      errors.push(
        stale(
          name,
          `the check for "${assertion.reference}" is out of date: the runbook no longer says it`,
        ),
      );
    }
    if (!repo.exists(assertion.file)) {
      errors.push(stale(name, `${assertion.file} (for "${assertion.reference}") no longer exists`));
      continue;
    }
    const found = assertion.pattern.test(repo.read(assertion.file));
    if (assertion.absent ? found : !found) {
      errors.push(
        stale(
          name,
          `"${assertion.reference}" is stale — ${assertion.claim} ` +
            `(${assertion.absent ? "unexpectedly found" : "not found"} in ${assertion.file}: ` +
            `${assertion.pattern})`,
        ),
      );
    }
  }

  return { errors, warnings };
}

// ── The runbooks ──────────────────────────────────────────────────────────

const SIGNING_KEYS_FILE = "scripts/verify-signing-keys.ts";

export const RUNBOOKS: readonly RunbookSpec[] = [
  {
    path: "docs/runbooks/sponsor-key-rotation.md",
    externalEnvKeys: [],
    assertions: [
      {
        reference: "`SPONSOR_SECRET_KEY` / `SPONSOR_PUBLIC_KEY`",
        file: "render.yaml",
        pattern: /-\s*key:\s*SPONSOR_SECRET_KEY\b[\s\S]*?-\s*key:\s*SPONSOR_PUBLIC_KEY\b/,
        claim: "both sponsor secrets are declared in the Render blueprint",
      },
      {
        reference: "`RELAYER_API_KEY`",
        file: "render.yaml",
        pattern: /-\s*key:\s*RELAYER_API_KEY\b/,
        claim: "the relayer key is a blueprint secret that is re-provisioned after recovery",
      },
      {
        reference: "`render.yaml` disables `autoDeploy`",
        file: "render.yaml",
        pattern: /^\s*autoDeploy:\s*false\b/m,
        claim: "a manual deploy is required to pick up a new secret",
      },
      {
        reference: "--sponsor G<new-public-key>",
        file: SIGNING_KEYS_FILE,
        pattern: /case\s+"--sponsor"/,
        claim: "the verification script accepts --sponsor",
      },
      {
        reference: "--network mainnet",
        file: SIGNING_KEYS_FILE,
        pattern: /case\s+"--network"/,
        claim: "the verification script accepts --network",
      },
      {
        reference: "`verifySigningKeys` in `services/wallet-service/src/index.ts` runs",
        file: "services/wallet-service/src/index.ts",
        pattern: /\bverifySigningKeys\(/,
        claim: "wallet-service checks the sponsor key on every boot",
      },
      {
        reference: "both `wallet-service` and `policy-service`",
        file: "services/wallet-service/src/index.ts",
        pattern: /signingKeyFromEnv\("sponsor"\)/,
        claim: "wallet-service reads the sponsor identity",
      },
      {
        reference: "both `wallet-service` and `policy-service`",
        file: "services/policy-service/src/index.ts",
        pattern: /signingKeyFromEnv\("sponsor"\)/,
        claim: "policy-service reads the sponsor identity",
      },
      {
        reference: "both `wallet-service` and `policy-service`",
        file: "services/worker-service/src/index.ts",
        pattern: /signingKeyFromEnv\("sponsor"\)/,
        absent: true,
        claim: "no other service consumes the sponsor identity, so its rotation is complete",
      },
      {
        reference: "`probeSigningKeysOnChain` logs",
        file: "services/wallet-service/src/index.ts",
        pattern: /probeSigningKeysOnChain\(/,
        claim: "the on-chain confirmation probe still runs at boot",
      },
      {
        reference: "confirmed on",
        file: "services/wallet-service/src/index.ts",
        pattern: /console\.info\(\s*`[^`]*\$\{r\.role\} key \$\{r\.publicKey\} confirmed on /,
        claim: "the boot log line an operator looks for, at info level",
      },
      {
        reference: "a warning means the new account is not yet",
        file: "services/wallet-service/src/index.ts",
        pattern: /console\.warn\(\s*`[^`]*key \$\{r\.publicKey\} could not be confirmed on /,
        claim: "an unfunded or missing account produces a warning, not silence",
      },
    ],
  },
  {
    path: "docs/runbooks/x402-cold-start-and-retry-safety.md",
    assertions: [
      {
        reference: "`/lifecycle/execute` in `lifecycle-service`",
        file: "services/lifecycle-service/src/server.ts",
        pattern: /"POST \/lifecycle\/execute":\s*\{[\s\S]*?maxTimeoutSeconds:\s*300\b/,
        claim: "the lifecycle x402 route declares a 300s payment timeout",
      },
      {
        reference: "`/verification/:contractId` in `verification-service`",
        file: "services/verification-service/src/server.ts",
        pattern: /"GET \/verification\/:contractId":\s*\{[\s\S]*?maxTimeoutSeconds:\s*300\b/,
        claim: "the verification x402 route declares a 300s payment timeout",
      },
      {
        reference: "`connectionTimeout` defaults to `310_000ms` (310s)",
        file: "services/api-gateway/src/server.ts",
        pattern: /numEnv\("REQUEST_TIMEOUT_MS",\s*310_000\)/,
        claim: "the gateway's request timeout defaults to 310s, above the 300s payment gate",
      },
      {
        reference: "`connectionTimeout` defaults to `310_000ms` (310s)",
        file: "services/api-gateway/src/server.ts",
        pattern: /connectionTimeout:\s*requestTimeoutMs/,
        claim: "that request timeout is what the gateway uses as its connectionTimeout",
      },
      {
        reference: "`HTTPFacilitatorClient` defaults to `https://vellar-facilitator.onrender.com`",
        file: "services/lifecycle-service/src/server.ts",
        pattern: /new HTTPFacilitatorClient\(\{\s*url:\s*"https:\/\/vellar-facilitator\.onrender\.com"/,
        claim: "lifecycle-service defaults to the vellar-facilitator deployment",
      },
      {
        reference: "`HTTPFacilitatorClient` defaults to `https://vellar-facilitator.onrender.com`",
        file: "services/verification-service/src/server.ts",
        pattern: /new HTTPFacilitatorClient\(\{\s*url:\s*"https:\/\/vellar-facilitator\.onrender\.com"/,
        claim: "verification-service defaults to the vellar-facilitator deployment",
      },
      {
        reference: "sleeps after 15 minutes idle",
        file: "render.yaml",
        pattern: /SLEEPS after 15 min idle \(~1 min cold start/i,
        claim: "render.yaml still documents the free-tier sleep and ~1 minute cold start",
      },
      {
        reference: "the facilitator advertises `areFeesSponsored` and rebuilds the tx",
        file: "docs/design-x402-sdk-client.md",
        pattern: /areFeesSponsored/,
        claim: "the design doc still records that the facilitator rebuilds the transaction",
      },
      {
        reference: "no settlement-status-check endpoint exists anywhere",
        file: "services/lifecycle-service/src/server.ts",
        pattern: /\bapp\.(?:get|post|put|patch|delete)\(\s*["'`][^"'`]*settle/i,
        absent: true,
        claim: "a settlement-status route now exists, so the runbook's 'no endpoint' gap is closed",
      },
      {
        reference: "no settlement-status-check endpoint exists anywhere",
        file: "services/verification-service/src/server.ts",
        pattern: /\bapp\.(?:get|post|put|patch|delete)\(\s*["'`][^"'`]*settle/i,
        absent: true,
        claim: "a settlement-status route now exists, so the runbook's 'no endpoint' gap is closed",
      },
      {
        reference: "no settlement-status-check endpoint exists anywhere",
        file: "services/wallet-service/src/server.ts",
        pattern: /\bapp\.(?:get|post|put|patch|delete)\(\s*["'`][^"'`]*settle/i,
        absent: true,
        claim: "a settlement-status route now exists, so the runbook's 'no endpoint' gap is closed",
      },
      {
        reference: "no settlement-status-check endpoint exists anywhere",
        file: "services/api-gateway/src/server.ts",
        pattern: /\bapp\.(?:get|post|put|patch|delete)\(\s*["'`][^"'`]*settle/i,
        absent: true,
        claim: "a settlement-status route now exists, so the runbook's 'no endpoint' gap is closed",
      },
      {
        reference: "nothing in this repository's backend can distinguish",
        file: "services/lifecycle-service/src/server.ts",
        pattern: /retryWithBackoff/,
        absent: true,
        claim: "the x402 route file applies no retry helper of its own to a payment",
      },
      {
        reference: "nothing in this repository's backend can distinguish",
        file: "services/verification-service/src/server.ts",
        pattern: /retryWithBackoff/,
        absent: true,
        claim: "the x402 route file applies no retry helper of its own to a payment",
      },
    ],
  },
];

// ── Repo wiring ───────────────────────────────────────────────────────────

export function repoReader(root: string): RepoReader {
  const gitignore = existsSync(join(root, ".gitignore"))
    ? readFileSync(join(root, ".gitignore"), "utf8")
    : "";
  return {
    exists: (path) => existsSync(join(root, path)),
    read: (path) => readFileSync(join(root, path), "utf8"),
    gitignored: new Set(
      gitignore
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    ),
  };
}

export function runRunbookChecks(root: string): RunbookReport {
  const repo = repoReader(root);
  const report: RunbookReport = { errors: [], warnings: [] };
  for (const spec of RUNBOOKS) {
    const result = checkRunbook(spec, repo);
    report.errors.push(...result.errors);
    report.warnings.push(...result.warnings);
  }
  return report;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { errors, warnings } = runRunbookChecks(root);
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(
      `\n✗ ${errors.length} stale runbook reference(s). Update the runbook or the code.`,
    );
    process.exit(1);
  }
  console.log(`✓ Runbooks match the code (${warnings.length} warning(s)).`);
}

// Only run when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
