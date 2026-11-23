import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RUNBOOKS,
  checkRunbook,
  extractCodeSpans,
  extractEnvKeys,
  extractFilePaths,
  extractScriptCalls,
  repoReader,
  runRunbookChecks,
  type RepoReader,
  type RunbookSpec,
} from "./runbook-freshness";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Extraction ────────────────────────────────────────────────────────────

const SAMPLE = [
  "# Rotate",
  "Set `SPONSOR_SECRET_KEY` / `SPONSOR_PUBLIC_KEY` in `render.yaml` (see `docs/decisions.md`).",
  "The code is in `services/wallet-service/src/index.ts` and `x402-client.ts` (other repo).",
  "Call `verifySigningKeys` or `signingKeyFromEnv(\"sponsor\")`.",
  "",
  "   ```",
  "   tsx scripts/verify-signing-keys.ts --network mainnet --sponsor G<new-key>",
  "   ```",
  "",
  "```bash",
  "$ npx tsx scripts/other.ts --dry-run",
  "pnpm install",
  "```",
].join("\n");

describe("extractCodeSpans", () => {
  it("returns inline code spans and ignores fence markers", () => {
    const spans = extractCodeSpans(SAMPLE);
    expect(spans).toContain("SPONSOR_SECRET_KEY");
    expect(spans).toContain("services/wallet-service/src/index.ts");
    expect(spans).toContain('signingKeyFromEnv("sponsor")');
    expect(spans.some((s) => s.startsWith("`"))).toBe(false);
  });
});

describe("extractFilePaths", () => {
  it("returns repo-relative paths, de-duplicated", () => {
    expect(extractFilePaths(`${SAMPLE}\nAgain \`services/wallet-service/src/index.ts\`.`)).toEqual([
      "docs/decisions.md",
      "services/wallet-service/src/index.ts",
    ]);
  });

  it("ignores bare file names (they live in another repo or are private docs)", () => {
    expect(extractFilePaths("`x402-client.ts`, `idea.md`, `render.yaml`")).toEqual([]);
  });
});

describe("extractEnvKeys", () => {
  it("returns UPPER_SNAKE_CASE tokens only", () => {
    expect(extractEnvKeys(SAMPLE)).toEqual(["SPONSOR_SECRET_KEY", "SPONSOR_PUBLIC_KEY"]);
    expect(extractEnvKeys("`autoDeploy`, `Foo_Bar`, `ALLCAPS`, `A_B`")).toEqual(["A_B"]);
  });
});

describe("extractScriptCalls", () => {
  it("finds fenced tsx commands (plain, $-prefixed and npx) with their flags", () => {
    expect(extractScriptCalls(SAMPLE)).toEqual([
      {
        script: "scripts/verify-signing-keys.ts",
        flags: ["--network", "--sponsor"],
        line: 7,
      },
      { script: "scripts/other.ts", flags: ["--dry-run"], line: 11 },
    ]);
  });

  it("ignores commands that are not in a fenced block", () => {
    expect(extractScriptCalls("Run tsx scripts/a.ts --x inline.")).toEqual([]);
  });
});

// ── checkRunbook ──────────────────────────────────────────────────────────

function repoOf(files: Record<string, string>, gitignored: string[] = []): RepoReader {
  return {
    exists: (path) => path in files,
    read: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    gitignored: new Set(gitignored),
  };
}

const RUNBOOK = [
  "# Runbook",
  "Rotate `SPONSOR_SECRET_KEY` (declared in `render.yaml`) via `scripts/verify.ts`.",
  "",
  "```",
  "tsx scripts/verify.ts --network mainnet",
  "```",
  "",
  "Both services consume the sponsor identity, and `render.yaml` disables",
  "`autoDeploy` on purpose.",
].join("\n");

const FILES = {
  "docs/runbooks/r.md": RUNBOOK,
  "render.yaml": "services:\n  autoDeploy: false\n  envVars:\n    - key: SPONSOR_SECRET_KEY\n",
  "scripts/verify.ts": 'switch (arg) { case "--network": break; }',
  "services/a/index.ts": 'signingKeyFromEnv("sponsor")',
  "services/b/index.ts": 'signingKeyFromEnv("attestor")',
};

const SPEC: RunbookSpec = {
  path: "docs/runbooks/r.md",
  assertions: [
    {
      reference: "Both services consume the sponsor identity",
      file: "services/a/index.ts",
      pattern: /signingKeyFromEnv\("sponsor"\)/,
      claim: "service a reads the sponsor identity",
    },
    {
      reference: "Both services consume the sponsor identity",
      file: "services/b/index.ts",
      pattern: /signingKeyFromEnv\("sponsor"\)/,
      absent: true,
      claim: "service b does not",
    },
    {
      reference: "`render.yaml` disables `autoDeploy`",
      file: "render.yaml",
      pattern: /autoDeploy:\s*false/,
      claim: "auto deploy is off",
    },
  ],
};

describe("checkRunbook", () => {
  it("passes when every path, command, key and assertion still holds", () => {
    expect(checkRunbook(SPEC, repoOf(FILES))).toEqual({ errors: [], warnings: [] });
  });

  it("matches a reference the runbook wraps across lines", () => {
    // "`render.yaml` disables\n`autoDeploy`" is wrapped in RUNBOOK above.
    expect(checkRunbook(SPEC, repoOf(FILES)).errors).toEqual([]);
  });

  it("names a referenced file that no longer exists", () => {
    const files = { ...FILES };
    delete (files as Record<string, string>)["scripts/verify.ts"];
    const { errors } = checkRunbook(SPEC, repoOf(files));
    expect(errors).toContain(
      "docs/runbooks/r.md: references `scripts/verify.ts`, which no longer exists",
    );
    expect(errors.some((e) => e.includes("command runs scripts/verify.ts"))).toBe(true);
  });

  it("only warns about a missing file that is gitignored", () => {
    const runbook = `${RUNBOOK}\nSee \`docs/decisions.md\`.`;
    const repo = repoOf({ ...FILES, "docs/runbooks/r.md": runbook }, ["docs/decisions.md"]);
    const { errors, warnings } = checkRunbook(SPEC, repo);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      "docs/runbooks/r.md: `docs/decisions.md` is gitignored, so it cannot be verified in CI",
    ]);
  });

  it("flags a fenced command whose script no longer handles a flag", () => {
    const repo = repoOf({ ...FILES, "scripts/verify.ts": 'case "--net": break;' });
    expect(checkRunbook(SPEC, repo).errors).toEqual([
      "docs/runbooks/r.md: line 5: scripts/verify.ts no longer handles the --network flag",
    ]);
  });

  it("flags an env key that render.yaml does not declare", () => {
    const repo = repoOf({ ...FILES, "render.yaml": "autoDeploy: false\nenvVars: []\n" });
    expect(checkRunbook(SPEC, repo).errors).toEqual([
      "docs/runbooks/r.md: names `SPONSOR_SECRET_KEY`, which render.yaml does not declare",
    ]);
  });

  it("accepts an env key that is listed as external", () => {
    const repo = repoOf({ ...FILES, "render.yaml": "autoDeploy: false\n" });
    expect(checkRunbook({ ...SPEC, externalEnvKeys: ["SPONSOR_SECRET_KEY"] }, repo).errors).toEqual(
      [],
    );
  });

  it("flags a code assertion whose pattern is no longer in the file", () => {
    const repo = repoOf({ ...FILES, "services/a/index.ts": "nothing here" });
    const { errors } = checkRunbook(SPEC, repo);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"Both services consume the sponsor identity" is stale');
    expect(errors[0]).toContain("service a reads the sponsor identity");
    expect(errors[0]).toContain("not found in services/a/index.ts");
  });

  it("flags an 'absent' assertion when the forbidden code appears", () => {
    const repo = repoOf({ ...FILES, "services/b/index.ts": 'signingKeyFromEnv("sponsor")' });
    const { errors } = checkRunbook(SPEC, repo);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("service b does not");
    expect(errors[0]).toContain("unexpectedly found in services/b/index.ts");
  });

  it("flags an assertion whose file was deleted", () => {
    const files = { ...FILES };
    delete (files as Record<string, string>)["services/a/index.ts"];
    expect(checkRunbook(SPEC, repoOf(files)).errors).toEqual([
      'docs/runbooks/r.md: services/a/index.ts (for "Both services consume the sponsor identity") no longer exists',
    ]);
  });

  it("flags an assertion whose runbook text was removed or reworded", () => {
    const repo = repoOf({
      ...FILES,
      "docs/runbooks/r.md": RUNBOOK.replace(
        "Both services consume the sponsor identity",
        "Reworded",
      ),
    });
    const { errors } = checkRunbook(SPEC, repo);
    expect(errors).toHaveLength(2); // one per assertion that quoted that sentence
    expect(errors[0]).toContain("the runbook no longer says it");
  });
});

// ── The real repository ───────────────────────────────────────────────────

describe("this repository's runbooks", () => {
  it("covers both the sponsor-key and the x402 runbooks", () => {
    expect(RUNBOOKS.map((r) => r.path)).toEqual([
      "docs/runbooks/sponsor-key-rotation.md",
      "docs/runbooks/x402-cold-start-and-retry-safety.md",
    ]);
  });

  it("have no stale references (paths, commands, keys, code claims)", () => {
    expect(runRunbookChecks(ROOT).errors).toEqual([]);
  });

  it("every assertion for the real runbooks still quotes text the runbook contains", () => {
    const repo = repoReader(ROOT);
    for (const spec of RUNBOOKS) {
      const text = repo.read(spec.path).replace(/\s+/g, " ");
      for (const assertion of spec.assertions) {
        expect(text).toContain(assertion.reference.replace(/\s+/g, " "));
      }
    }
  });

  it("detects drift when a documented value changes in the code", () => {
    const real = repoReader(ROOT);
    const drifted: RepoReader = {
      ...real,
      read: (path) =>
        path === "services/lifecycle-service/src/server.ts"
          ? real.read(path).replace("maxTimeoutSeconds: 300", "maxTimeoutSeconds: 30")
          : real.read(path),
    };
    const x402 = RUNBOOKS.find((r) => r.path.includes("x402"))!;
    const { errors } = checkRunbook(x402, drifted);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("the lifecycle x402 route declares a 300s payment timeout");
  });

  it("detects the sponsor runbook going stale when a service starts using the sponsor key", () => {
    const real = repoReader(ROOT);
    const drifted: RepoReader = {
      ...real,
      read: (path) =>
        path === "services/worker-service/src/index.ts"
          ? `${real.read(path)}\nsigningKeyFromEnv("sponsor");`
          : real.read(path),
    };
    const sponsor = RUNBOOKS.find((r) => r.path.includes("sponsor"))!;
    const { errors } = checkRunbook(sponsor, drifted);
    expect(errors.some((e) => e.includes("no other service consumes the sponsor identity"))).toBe(
      true,
    );
  });
});

// ── #752: the numbers the x402 runbook's reasoning depends on ─────────────

describe("x402 runbook timeout arithmetic (#752)", () => {
  const repo = repoReader(ROOT);
  const timeoutOf = (file: string) =>
    Number(/maxTimeoutSeconds:\s*(\d+)/.exec(repo.read(file))?.[1]);

  const lifecycle = timeoutOf("services/lifecycle-service/src/server.ts");
  const verification = timeoutOf("services/verification-service/src/server.ts");
  const gatewayDefaultMs = Number(
    /numEnv\("REQUEST_TIMEOUT_MS",\s*([\d_]+)\)/.exec(
      repo.read("services/api-gateway/src/server.ts"),
    )?.[1]?.replace(/_/g, ""),
  );
  const coldStartSeconds = 60; // "roughly 1 minute" per render.yaml and the runbook

  it("both x402-gated routes declare the same 300s payment budget", () => {
    expect(lifecycle).toBe(300);
    expect(verification).toBe(300);
  });

  it("the gateway's default timeout is exactly 10s above the payment budget", () => {
    expect(gatewayDefaultMs).toBe(310_000);
    expect(gatewayDefaultMs / 1000 - lifecycle).toBe(10);
  });

  it("a cold start alone fits inside the payment budget with headroom (the runbook's conclusion)", () => {
    expect(coldStartSeconds).toBeLessThan(lifecycle);
    expect(lifecycle / coldStartSeconds).toBeGreaterThanOrEqual(4);
  });
});
