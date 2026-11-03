import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { findRenderUrls, isCheckedPath } from "./check-no-render-urls.mjs";

// Render is retired; everything deploys on Railway. A Render host left in source
// (a default URL, a fixture, a workflow that pings it) is a dead dependency that
// fails silently. This check fails on any onrender.com host outside docs.

const HOST = "vellar-backend" + ".onrender.com"; // split so this file never matches itself

describe("isCheckedPath", () => {
  for (const p of [
    "services/lifecycle-service/src/server.ts",
    "services/lifecycle-service/src/server.test.ts",
    "apps/web/app/page.tsx",
    ".github/workflows/ci.yml",
    "package.json",
    "railway.json",
    "Dockerfile",
    "infra/staging/staging.env.example",
    "scripts/some-tool.mjs",
  ]) {
    it(`checks ${p}`, () => assert.equal(isCheckedPath(p), true));
  }
  for (const p of [
    "README.md",
    "docs/security-audit.md",
    "docs/runbooks/staging-and-promotion.md",
    "apps/docs/policy-contract.md",
    "apps/docs/anything.mdx",
    "pnpm-lock.yaml",
    "package-lock.json",
    "scripts/check-no-render-urls.mjs",
    "scripts/check-no-render-urls.test.mjs",
    "packages/service-kit/src/facilitator-url.ts",
    "packages/service-kit/src/facilitator-url.test.ts",
    "packages/service-kit/src/facilitator-url.boot.test.ts",
  ]) {
    it(`does not check ${p}`, () => assert.equal(isCheckedPath(p), false));
  }
});

describe("findRenderUrls", () => {
  it("reports file, line number and text for a Render host", () => {
    const hits = findRenderUrls([
      { path: "src/a.ts", content: `const ok = 1;\nconst url = "https://${HOST}/health";\n` },
    ]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, "src/a.ts");
    assert.equal(hits[0].line, 2);
    assert.match(hits[0].text, /onrender\.com/);
  });

  it("matches case-insensitively and any subdomain", () => {
    const hits = findRenderUrls([
      { path: "a.ts", content: "x = 'https://Foo-Bar.OnRender.COM'" },
      { path: "b.yml", content: "url: https://another-service.onrender.com/x" },
    ]);
    assert.equal(hits.length, 2);
  });

  it("reports every occurrence, across files", () => {
    const hits = findRenderUrls([
      { path: "a.ts", content: `${HOST}\n${HOST}\n` },
      { path: "b.ts", content: HOST },
    ]);
    assert.equal(hits.length, 3);
  });

  it("ignores docs even when they name a Render host", () => {
    assert.deepEqual(
      findRenderUrls([
        { path: "docs/runbook.md", content: HOST },
        { path: "README.md", content: HOST },
      ]),
      [],
    );
  });

  it("finds nothing in clean files", () => {
    assert.deepEqual(
      findRenderUrls([{ path: "a.ts", content: "const url = process.env.FACILITATOR_URL;" }]),
      [],
    );
  });

  it("does not match a host that merely contains the word", () => {
    assert.deepEqual(
      findRenderUrls([{ path: "a.ts", content: "https://onrender.example.org" }]),
      [],
    );
  });

  it("does not match the Railway-style hosts that replaced it", () => {
    assert.deepEqual(
      findRenderUrls([
        { path: "a.ts", content: "https://vellar-backend-production.up.railway.app" },
      ]),
      [],
    );
  });
});

describe("the CLI", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-no-render-urls.mjs");

  function repoWith(files) {
    const dir = mkdtempSync(join(tmpdir(), "render-check-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    execFileSync("git", ["add", "."], { cwd: dir });
    return dir;
  }

  it("exits 0 on a clean repository", () => {
    const dir = repoWith({ "src/a.ts": "export const a = 1;\n", "docs/x.md": HOST });
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  });

  it("exits 1 and names the file and line when source mentions a Render host", () => {
    const dir = repoWith({ "src/a.ts": `// ok\nconst u = "https://${HOST}";\n` });
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /src\/a\.ts:2/);
  });

  it("only looks at tracked files (an untracked scratch file does not fail the check)", () => {
    const dir = repoWith({ "src/a.ts": "export const a = 1;\n" });
    writeFileSync(join(dir, "scratch.ts"), HOST);
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  });

  it("skips binary files instead of crashing", () => {
    const dir = repoWith({ "src/a.ts": "export const a = 1;\n" });
    writeFileSync(join(dir, "logo.png"), Buffer.from([0, 1, 2, 0, 255, 254, 0, 0]));
    execFileSync("git", ["add", "."], { cwd: dir });
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  });

  it("the real repository has no Render host in non-doc source", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const r = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  });
});
