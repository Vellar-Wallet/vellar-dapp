import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashArtifact } from "./artifact";

// BuildExecutor (technical-doc.md §8.4): the seam that rebuilds a submitted
// contract deterministically, in isolation, and returns the built wasm bytes.
//
// This mirrors the wallet-service TransactionSubmitter / policy-service
// PolicyDeployer pattern: a real implementation behind an interface, with a
// loud failure when the real infra isn't configured. Two implementations ship:
//
//   • dockerBuildExecutor — the REAL path. Clones the repo at the pinned commit
//     into an isolated container and runs a reproducible Soroban build. Only
//     works where Docker + the toolchain image are available (a real build box,
//     never CI or the free-tier host).
//   • stubBuildExecutor — a deterministic placeholder for CI / hosted demo,
//     where real Rust builds cannot run. It NEVER pretends a build succeeded
//     against a real contract: it returns synthetic bytes derived from the job
//     inputs, so the pipeline is exercised end-to-end but a match only occurs
//     against a known synthetic deployed hash (used in tests).
//
// The worker chooses the executor from config; an unconfigured "real" build
// fails loudly rather than silently producing a wrong answer.

export interface BuildInput {
  sourceType: "repo" | "upload";
  repoUrl?: string;
  commitHash?: string;
  sourceArchiveRef?: string;
  toolchainVersion: string;
  buildFlags?: string[];
}

export interface BuildResult {
  /** The built contract wasm bytes. */
  wasm: Uint8Array;
  /** sha256 of `wasm` — the value compared against the deployed hash. */
  wasmHash: string;
  /** Human-readable build log, surfaced to the submitter. */
  log: string;
}

export class BuildExecutorError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "clone_failed"
      | "build_failed"
      | "artifact_missing"
      | "unsupported_source",
    readonly log = "",
  ) {
    super(message);
    this.name = "BuildExecutorError";
  }
}

export interface BuildExecutor {
  build(input: BuildInput): Promise<BuildResult>;
}

// --- Stub executor (CI / hosted) ---------------------------------------------

/**
 * A deterministic, dependency-free executor. Given the same inputs it always
 * produces the same synthetic wasm bytes — enough to drive the full pipeline
 * (build → hash → compare) in environments that cannot run a real Rust build.
 *
 * It is honest by construction: the bytes are derived from the job inputs, so
 * they will NOT match a real deployed contract's hash. A "verified" result from
 * the stub only happens in tests, where the deployed hash is the matching
 * synthetic value. In the hosted demo the stub therefore yields "failed"
 * (mismatch) rather than a false "verified".
 */
export function stubBuildExecutor(): BuildExecutor {
  return {
    async build(input) {
      const seed = [
        input.sourceType,
        input.repoUrl ?? "",
        input.commitHash ?? "",
        input.sourceArchiveRef ?? "",
        input.toolchainVersion,
        (input.buildFlags ?? []).join(" "),
      ].join("\n");
      const wasm = new TextEncoder().encode(`vela-stub-wasm\n${seed}`);
      return {
        wasm,
        wasmHash: hashArtifact(wasm),
        log: [
          "[stub build executor] no real Rust/Docker build performed.",
          "Produced deterministic synthetic bytes from the submission inputs.",
          `toolchain=${input.toolchainVersion} flags=${(input.buildFlags ?? []).join(" ") || "(none)"}`,
        ].join("\n"),
      };
    },
  };
}

// --- Docker executor (real builds) -------------------------------------------

export interface DockerBuildExecutorConfig {
  /** Toolchain image that has rustup + the wasm target + stellar CLI. */
  image: string;
  /** Absolute path to the wasm the build is expected to emit, relative to the
   * cloned repo root (e.g. target/wasm32-unknown-unknown/release/foo.wasm).
   * A submission may override it via buildFlags in a later iteration; for now
   * the worker discovers the single release wasm if this is not set. */
  expectedWasmPath?: string;
  /** Seconds before a build is killed (§8.4 — untrusted code must not run
   * unbounded). Default 600. Enforced by the `run` seam. */
  timeoutSeconds?: number;
  /** Container memory cap (docker --memory syntax, e.g. "2g"). Default "2g". */
  memory?: string;
  /** Container CPU cap (docker --cpus, e.g. "2"). Default "2". */
  cpus?: string;
  /** Max processes in the container (fork-bomb guard). Default 512. */
  pidsLimit?: number;
  /** Extra args passed to `stellar contract build` (e.g. a package selector). */
  buildArgs?: string[];
  /** Injected for tests; defaults to spawning real processes. `timeoutMs`, when
   * given, hard-kills the child after that long and resolves with code 124. */
  run?: (
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs?: number,
  ) => Promise<{ code: number; out: string; timedOut?: boolean }>;
}

/**
 * The real, isolated build path. Clones the repo at the exact commit into a
 * throwaway directory, then runs a reproducible build inside the toolchain
 * container. Only usable where Docker + the image exist; otherwise every call
 * fails loudly with code "not_configured" via the guard in the worker.
 *
 * NOTE: perfect determinism across arbitrary contracts is a known-hard problem
 * (compiler/OS/dep pinning) and continues to be hardened in Phase 7. This gives
 * the correct architecture and a working build path; it does not claim to make
 * every legitimate source reproduce on the first try.
 */
export function dockerBuildExecutor(config: DockerBuildExecutorConfig): BuildExecutor {
  const timeoutSeconds = config.timeoutSeconds ?? 600;
  const memory = config.memory ?? "2g";
  const cpus = config.cpus ?? "2";
  const pidsLimit = config.pidsLimit ?? 512;
  const run = config.run ?? defaultRun;

  return {
    async build(input) {
      if (input.sourceType !== "repo" || !input.repoUrl || !input.commitHash) {
        throw new BuildExecutorError(
          "docker executor currently supports repo submissions only",
          "unsupported_source",
        );
      }
      const workdir = await mkdtemp(join(tmpdir(), "vela-verify-"));
      const log: string[] = [];
      try {
        const clone = await run("git", ["clone", "--no-checkout", input.repoUrl, "repo"], workdir);
        log.push(clone.out);
        if (clone.code !== 0) {
          throw new BuildExecutorError("git clone failed", "clone_failed", log.join("\n"));
        }
        const repoDir = join(workdir, "repo");
        const checkout = await run("git", ["checkout", input.commitHash], repoDir);
        log.push(checkout.out);
        if (checkout.code !== 0) {
          throw new BuildExecutorError("git checkout failed", "clone_failed", log.join("\n"));
        }

        // Build inside the toolchain container under strict isolation (§8.4 —
        // the build runs UNTRUSTED, submitter-provided code):
        //   --network=none        no network (hermetic + can't exfiltrate/attack)
        //   --memory/--cpus       cap resources so one build can't starve the host
        //   --pids-limit          fork-bomb guard
        //   --read-only           root FS is immutable; only the mounted repo +
        //                         a tmpfs /tmp are writable, so untrusted code
        //                         can't tamper with the toolchain image
        //   --cap-drop=ALL        drop every Linux capability
        //   --security-opt no-new-privileges  block setuid privilege escalation
        //   --user 1000:1000      non-root
        // The build is also time-bounded (timeoutSeconds) so it can't hang the
        // worker forever.
        const build = await run(
          "docker",
          [
            "run",
            "--rm",
            "--network=none",
            "--memory",
            memory,
            "--memory-swap",
            memory, // == --memory disables swap (no extra swap headroom)
            "--cpus",
            cpus,
            "--pids-limit",
            String(pidsLimit),
            "--read-only",
            "--tmpfs",
            "/tmp:exec",
            "--cap-drop=ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            "1000:1000",
            "-v",
            `${repoDir}:/work`,
            "-w",
            "/work",
            config.image,
            "stellar",
            "contract",
            "build",
            ...(config.buildArgs ?? []),
          ],
          repoDir,
          timeoutSeconds * 1000,
        );
        log.push(build.out);
        if (build.timedOut) {
          throw new BuildExecutorError(
            `build exceeded the ${timeoutSeconds}s timeout and was killed`,
            "build_failed",
            log.join("\n"),
          );
        }
        if (build.code !== 0) {
          throw new BuildExecutorError("contract build failed", "build_failed", log.join("\n"));
        }

        const wasmPath = config.expectedWasmPath
          ? join(repoDir, config.expectedWasmPath)
          : await findReleaseWasm(repoDir, run);
        let wasm: Buffer;
        try {
          wasm = await readFile(wasmPath);
        } catch {
          throw new BuildExecutorError(
            `expected wasm artifact not found at ${wasmPath}`,
            "artifact_missing",
            log.join("\n"),
          );
        }

        const bytes = new Uint8Array(wasm);
        return { wasm: bytes, wasmHash: hashArtifact(bytes), log: log.join("\n") };
      } finally {
        await rm(workdir, { recursive: true, force: true });
      }
    },
  };
}

/** Locate the single release wasm the build emitted. Soroban's wasm target has
 * moved across toolchains — modern soroban-sdk (27+) builds to `wasm32v1-none`,
 * older ones to `wasm32-unknown-unknown` — so check both release dirs. If a
 * build emits more than one wasm, the submission must set `expectedWasmPath`
 * (a multi-contract workspace is ambiguous otherwise). */
async function findReleaseWasm(
  repoDir: string,
  run: (cmd: string, args: string[], cwd: string) => Promise<{ code: number; out: string }>,
): Promise<string> {
  const found = await run(
    "sh",
    [
      "-c",
      "ls target/wasm32v1-none/release/*.wasm target/wasm32-unknown-unknown/release/*.wasm 2>/dev/null",
    ],
    repoDir,
  );
  const paths = found.out
    .trim()
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length === 0) {
    throw new BuildExecutorError("no release wasm produced by the build", "artifact_missing");
  }
  if (paths.length > 1) {
    throw new BuildExecutorError(
      `build produced ${paths.length} wasm artifacts; set expectedWasmPath to disambiguate:\n${paths.join("\n")}`,
      "artifact_missing",
    );
  }
  return join(repoDir, paths[0]!);
}

function defaultRun(cmd: string, args: string[], cwd: string, timeoutMs?: number) {
  return new Promise<{ code: number; out: string; timedOut?: boolean }>((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let out = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        // SIGKILL the process group; `docker run --rm` tears down the container
        // when its client process dies, so the build stops too.
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    const done = (result: { code: number; out: string; timedOut?: boolean }) => {
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => done({ code: timedOut ? 124 : (code ?? 1), out, timedOut }));
    child.on("error", (err) => done({ code: 1, out: `${out}\n${err.message}`, timedOut }));
  });
}
