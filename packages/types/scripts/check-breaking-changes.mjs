#!/usr/bin/env node
// check-breaking-changes — flags removed or narrowed exported types in
// packages/types without an accompanying BREAKING comment (issue #552).

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const SRC = "packages/types/src";

function getDiff(base) {
  try {
    return execSync(`git diff ${base} -- ${SRC}`, { cwd: resolve(PKG_ROOT, "../.."), encoding: "utf8" });
  } catch {
    return "";
  }
}

function getStagedDiff() {
  try {
    return execSync(`git diff --cached -- ${SRC}`, { cwd: resolve(PKG_ROOT, "../.."), encoding: "utf8" });
  } catch {
    return "";
  }
}

/**
 * Parse a unified diff for packages/types/src and extract:
 * - removed exported type/interface declarations
 * - whether a BREAKING comment exists in the diff (added or context lines)
 */
export function parseDiffForBreakingChanges(diff) {
  const violations = [];
  const lines = diff.split("\n");
  let hasBreakingComment = false;
  let currentHunkRemovedExports = [];

  for (const line of lines) {
    if (/^\+\+\+|^---|^@@/.test(line)) {
      // Flush previous hunk
      if (currentHunkRemovedExports.length > 0 && !hasBreakingComment) {
        violations.push(...currentHunkRemovedExports);
      }
      currentHunkRemovedExports = [];
      if (/^@@/.test(line)) hasBreakingComment = false;
      continue;
    }

    // BREAKING comment in added (+) or context ( ) lines
    if (/^[+ ].*BREAKING:/.test(line)) {
      hasBreakingComment = true;
    }

    // Removed exported type/interface
    if (line.startsWith("-") && /^-\s*export\s+(type|interface|enum)\s+\w+/.test(line)) {
      const match = line.match(/^-\s*export\s+(type|interface|enum)\s+(\w+)/);
      if (match) {
        currentHunkRemovedExports.push(match[2]);
      }
    }
  }

  // Flush final hunk
  if (currentHunkRemovedExports.length > 0 && !hasBreakingComment) {
    violations.push(...currentHunkRemovedExports);
  }

  return violations;
}

// CLI entry — only run when executed directly, not when imported.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const args = process.argv.slice(2);
  let diff;
  if (args.includes("--staged")) {
    diff = getStagedDiff();
  } else {
    const baseIdx = args.indexOf("--base");
    const base = baseIdx !== -1 ? args[baseIdx + 1] : "HEAD";
    diff = getDiff(base);
  }

  const violations = parseDiffForBreakingChanges(diff);
  if (violations.length > 0) {
    console.error("BREAKING changes detected without a // BREAKING: comment:");
    for (const name of violations) {
      console.error(`  - ${name}`);
    }
    console.error("\nAdd a `// BREAKING:` comment above the change. See packages/types/README.md.");
    process.exit(1);
  } else {
    console.log("No undocumented breaking changes found.");
    process.exit(0);
  }
}
