import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashArtifact } from "./artifact";
import {
  CONTAINER_DEPS_DIR,
  DependencyPrefetchError,
  hermeticCargoConfig,
  hermeticGitConfig,
  HERMETIC_GIT_ENV,
  prefetchCargoDependencies,
  type PrefetchResult,
} from "./cargo-prefetch";
import {
  assertPublicHttpsRepoUrl,
  gitConnectionPinArgs,
  RepoUrlError,
  type ResolvedPin,
} from "./repo-url-guard";

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
      | "unsupported_source"
      | "repo_url_rejected"
      | "dependencies_unresolved"
      | "dependency_fetch_failed"
      | "insufficient_disk_space",
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
  /** Container tmpfs size cap for /tmp (e.g. "512m"). Default "512m". */
  tmpfsSize?: string;
  /** Storage driver options (e.g. "size=10G" for disk limits). */
  storageOpt?: string;
  /** Extra args passed to `stellar contract build` (e.g. a package selector). */
  buildArgs?: string[];
  /** Injected for tests; defaults to spawning real processes. `timeoutMs`, when
   * given, hard-kills the child after that long and resolves with code 124. */
  run?: (
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs?: number,
    env?: Record<string, string>,
  ) => Promise<{ code: number; out: string; timedOut?: boolean }>;
  /** repoUrl SSRF guard (FIX 6); defaults to the real https+DNS check. Injected
   * so tests don't hit the network. Throws RepoUrlError to reject, else returns
   * the validated pin (undefined for an IP-literal host). */
  assertRepoUrl?: (repoUrl: string) => Promise<ResolvedPin | undefined>;
  /** Dependency pre-fetch (#420); defaults to the guarded Cargo.lock pre-fetch.
   * Injected so unit tests that only inspect command wiring need no network. */
  prefetch?: (repoDir: string, depsDir: string) => Promise<PrefetchResult>;
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
  const tmpfsSize = config.tmpfsSize ?? "512m";
  const storageOpt = config.storageOpt;
  const run = config.run ?? defaultRun;
  const assertRepoUrl = config.assertRepoUrl ?? assertPublicHttpsRepoUrl;
  const prefetch =
    config.prefetch ??
    ((repoDir: string, depsDir: string) =>
      prefetchCargoDependencies(repoDir, depsDir, { run, assertUrl: assertRepoUrl }));

  return {
    async build(input) {
      if (input.sourceType !== "repo" || !input.repoUrl || !input.commitHash) {
        throw new BuildExecutorError(
          "docker executor currently supports repo submissions only",
          "unsupported_source",
        );
      }
      // SSRF guard (security-audit.md H2/FIX 6): the clone runs on the HOST,
      // outside the build sandbox. Require public https and re-resolve DNS right
      // before cloning, rejecting private/loopback/link-local answers. The guard
      // RETURNS the validated address so we can pin git's connection to it — git
      // otherwise resolves the hostname again independently (the TOCTOU window).
      let pin: ResolvedPin | undefined;
      try {
        pin = await assertRepoUrl(input.repoUrl);
      } catch (err) {
        if (err instanceof RepoUrlError) {
          throw new BuildExecutorError(err.message, "repo_url_rejected");
        }
        throw err;
      }

      const workdir = await mkdtemp(join(tmpdir(), "vela-verify-"));
      const log: string[] = [];
      try {
        // Pin git's connection to the guard-validated IP (http.curloptResolve)
        // AND forbid redirects (http.followRedirects=false) so git cannot be
        // sent to a different, unpinned host it would resolve freely. Only
        // https, and pass repoUrl after `--`.
        const clone = await run(
          "git",
          [
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            ...gitConnectionPinArgs(pin),
            "clone",
            "--no-checkout",
            "--",
            input.repoUrl,
            "repo",
          ],
          workdir,
          undefined,
          { GIT_TERMINAL_PROMPT: "0" },
        );
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

        // Dependency pre-fetch (#420): the ONLY post-clone stage with network,
        // and it runs no submitted code — Cargo.lock is read as data and every
        // host is either a fixed crates.io host or a guard-validated, pinned git
        // URL (cargo-prefetch.ts). Everything lands outside the repo checkout,
        // so the submission cannot pre-plant or overwrite it.
        const depsDir = join(workdir, "deps");
        const cargoHome = join(workdir, "cargo-home");
        let prefetched: PrefetchResult;
        try {
          prefetched = await prefetch(repoDir, depsDir);
        } catch (err) {
          if (err instanceof DependencyPrefetchError) {
            // No fallback: a submission whose dependencies cannot be resolved
            // here never reaches a build, networked or otherwise.
            log.push(`[prefetch] ${err.message}`);
            throw new BuildExecutorError(err.message, err.code, log.join("\n"));
          }
          throw err;
        }
        log.push(prefetched.log);
        await mkdir(depsDir, { recursive: true });
        await mkdir(cargoHome, { recursive: true });
        await writeFile(join(cargoHome, "config.toml"), hermeticCargoConfig());
        await writeFile(join(depsDir, "gitconfig"), hermeticGitConfig(prefetched.plan));
        // The container runs as 1000:1000, not the worker's uid, and must write
        // target/ and its CARGO_HOME. Both sit inside the 0700 mkdtemp workdir,
        // so opening them up does not expose them to other host users.
        await chmod(repoDir, 0o777);
        await chmod(cargoHome, 0o777);

        // Build inside the toolchain container under strict isolation (§8.4 —
        // the build runs UNTRUSTED, submitter-provided code):
        //   --network=none        no network at all: the build has only the
        //                         pre-fetched deps. Hard-coded, not configurable,
        //                         and there is no networked retry (#420).
        //   --memory/--cpus       cap resources so one build can't starve the host
        //   --pids-limit          fork-bomb guard
        //   --read-only           root FS is immutable; only the mounted repo, a
        //                         per-build CARGO_HOME and a tmpfs /tmp are
        //                         writable, so untrusted code can't tamper with
        //                         the toolchain image
        //   /deps:ro              pre-fetched registry + git mirrors, read-only
        //   --cap-drop=ALL        drop every Linux capability
        //   --security-opt no-new-privileges  block setuid privilege escalation
        //   --user 1000:1000      non-root
        //   --locked              build exactly what Cargo.lock (and so the
        //                         pre-fetch) pinned
        // The build is also time-bounded (timeoutSeconds) so it can't hang the
        // worker forever; the container is named so a timeout can remove it.
        const containerName = `vellar-build-${randomUUID()}`;
        const envArgs = Object.entries({
          CARGO_HOME: "/cargo-home",
          ...HERMETIC_GIT_ENV,
        }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
        const build = await run(
          "docker",
          [
            "run",
            "--rm",
            "--name",
            containerName,
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
            `/tmp:exec,size=${tmpfsSize}`,
            ...(storageOpt ? ["--storage-opt", storageOpt] : []),
            "--cap-drop=ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            "1000:1000",
            "-v",
            `${repoDir}:/work`,
            "-v",
            `${depsDir}:${CONTAINER_DEPS_DIR}:ro`,
            "-v",
            `${cargoHome}:/cargo-home`,
            ...envArgs,
            "-w",
            "/work",
            config.image,
            "stellar",
            "contract",
            "build",
            "--locked",
            ...(config.buildArgs ?? []),
          ],
          repoDir,
          timeoutSeconds * 1000,
        );
        log.push(build.out);
        if (build.timedOut) {
          // Killing the docker CLI does not stop the container; remove it.
          await run("docker", ["rm", "-f", containerName], repoDir);
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

export function defaultRun(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
  env?: Record<string, string>,
) {
  return new Promise<{ code: number; out: string; timedOut?: boolean }>((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env });
    let out = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        // SIGKILL the child. For `docker run` this kills only the CLI; the
        // executor removes the (named) container itself.
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
