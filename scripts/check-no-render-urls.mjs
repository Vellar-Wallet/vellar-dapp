#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Render is retired; everything deploys on Railway. This fails when any tracked,
// non-doc file mentions an onrender.com host: a default URL, a test fixture or a
// workflow that pings it is a dead dependency that fails silently. Docs are
// exempt because they legitimately record history. Run: pnpm check:render-urls

const RENDER_HOST = /(^|[^a-z0-9-])([a-z0-9-]+\.)*onrender\.com\b/i;
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);
// These name the host on purpose: this check, and the code and tests that REFUSE a Render
// FACILITATOR_URL at boot. Keep this list to exactly those files.
const SELF = new Set([
  "scripts/check-no-render-urls.mjs",
  "scripts/check-no-render-urls.test.mjs",
  "packages/service-kit/src/facilitator-url.ts",
  "packages/service-kit/src/facilitator-url.test.ts",
  "packages/service-kit/src/facilitator-url.boot.test.ts",
]);

/** Whether a repo-relative path is source this check should scan. */
export function isCheckedPath(path) {
  if (SELF.has(path)) return false;
  const base = path.split("/").pop() ?? path;
  if (LOCKFILES.has(base)) return false;
  if (/\.(md|mdx)$/i.test(path)) return false;
  if (path.split("/").includes("docs")) return false;
  return true;
}

/** Every line that names a Render host, in the files this check scans. */
export function findRenderUrls(files) {
  const hits = [];
  for (const { path, content } of files) {
    if (!isCheckedPath(path)) continue;
    content.split("\n").forEach((text, i) => {
      if (RENDER_HOST.test(text)) hits.push({ path, line: i + 1, text: text.trim().slice(0, 160) });
    });
  }
  return hits;
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function readTextFile(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return undefined; // deleted in the working tree, or a submodule
  }
  if (buf.includes(0)) return undefined; // binary
  return buf.toString("utf8");
}

function main() {
  const files = [];
  for (const path of trackedFiles()) {
    if (!isCheckedPath(path)) continue;
    const content = readTextFile(path);
    if (content !== undefined) files.push({ path, content });
  }
  const hits = findRenderUrls(files);
  if (hits.length === 0) {
    console.log(`No Render hosts in ${files.length} checked source files.`);
    return 0;
  }
  console.error("Render is retired; these lines still name an onrender.com host:\n");
  for (const h of hits) console.error(`  ${h.path}:${h.line}: ${h.text}`);
  console.error(
    "\nUse configuration (for example FACILITATOR_URL) or the Railway URL. Docs are exempt.",
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
