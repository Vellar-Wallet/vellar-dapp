import { createHash } from "node:crypto";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { join } from "node:path";
import {
  assertPublicHttpsRepoUrl,
  gitConnectionPinArgs,
  RepoUrlError,
  type ResolvedPin,
} from "./repo-url-guard";

// Hermetic dependency pre-fetch (issue #420, BUILD-PLAN Phase 7).
//
// The build container runs with --network=none, so every dependency it needs
// must be on disk before it starts. This module does that fetch on the HOST,
// from Cargo.lock only, and hands the build a cargo local-registry plus file://
// git mirrors. Nothing here executes submitted code: Cargo.lock is parsed as
// data, and cargo itself never runs with network access.
//
// The fetch is the only stage with network, so every destination goes through
// the same guard as the repo clone (H2 / FIX 6):
//   • crates.io packages are fetched from two FIXED hosts (index.crates.io,
//     static.crates.io). The lockfile only chooses crate names/versions, never
//     hosts. Each .crate is checked against the lockfile's sha256 checksum.
//   • git dependencies are the one place a submitter picks a host. Each URL goes
//     through assertPublicHttpsRepoUrl (public https, every DNS answer checked by
//     isBlockedAddress), and git is pinned to the validated IP with redirects
//     forbidden — identical to the executor's own clone.
//   • any other source (alternate registries, ssh/http/file git, path-less
//     registries) is refused. Refusal is final: there is no networked fallback.
//
// RA-7 (isBlockedAddress misses hex-form IPv4-mapped / NAT64 IPv6) is NOT made
// worse here: git URLs reuse the guard unchanged, and a bracketed IPv6 literal
// fails parseGitSource's character check before the guard is ever consulted.

export const CRATES_IO_INDEX = "https://index.crates.io";
export const CRATES_IO_DOWNLOAD = "https://static.crates.io/crates";

const CRATES_IO_SOURCES = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "sparse+https://index.crates.io/",
]);

// Path-safe shapes. Names/versions become file names on the host, so anything
// outside these is refused rather than escaped.
const CRATE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CRATE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;

const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_CRATE_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

// Disk-space preflight. Sizes are not known before the fetch (the lockfile has
// no byte counts), so the requirement is an estimate: a per-package allowance
// plus a fixed safety margin for index files, git object overhead and whatever
// else shares the volume. Override via PrefetchDeps.diskSpace.
export const DEFAULT_ESTIMATED_CRATE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ESTIMATED_GIT_DEP_BYTES = 256 * 1024 * 1024;
export const DEFAULT_DISK_SAFETY_MARGIN_BYTES = 512 * 1024 * 1024;

export type DependencyPrefetchErrorCode =
  /** The submission cannot be built offline as-is (missing/invalid lockfile,
   * unsupported source, unknown crate, checksum mismatch). Permanent. */
  | "dependencies_unresolved"
  /** A dependency host was unreachable or errored. Retryable — the retry is the
   * same guarded pre-fetch followed by the same offline build. */
  | "dependency_fetch_failed"
  /** A git dependency URL failed the SSRF guard. Permanent. */
  | "repo_url_rejected"
  /** The volume holding the deps directory is too small for the estimated
   * dependency tree. Raised before any download starts. A host condition, not
   * a defect in the submission. */
  | "insufficient_disk_space";

export class DependencyPrefetchError extends Error {
  constructor(
    message: string,
    readonly code: DependencyPrefetchErrorCode,
  ) {
    super(message);
    this.name = "DependencyPrefetchError";
  }
}

export interface LockedPackage {
  name: string;
  version: string;
  source?: string;
  checksum?: string;
}

/**
 * Parses the `[[package]]` tables of a Cargo.lock. Cargo.lock is generated,
 * flat TOML; this reads only the four string keys the pre-fetch needs and
 * refuses values it cannot read unambiguously (escapes, non-string values)
 * instead of guessing.
 */
export function parseCargoLock(text: string): LockedPackage[] {
  const packages: LockedPackage[] = [];
  let current: Partial<LockedPackage> | undefined;
  let inArray = false;

  const flush = () => {
    if (!current) return;
    if (!current.name || !current.version) {
      throw new DependencyPrefetchError(
        "Cargo.lock has a [[package]] entry without a name or version.",
        "dependencies_unresolved",
      );
    }
    packages.push(current as LockedPackage);
    current = undefined;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (inArray) {
      if (line.endsWith("]")) inArray = false;
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      flush();
      if (line === "[[package]]") current = {};
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!kv) {
      throw new DependencyPrefetchError(
        `Cargo.lock line could not be parsed: ${line.slice(0, 80)}`,
        "dependencies_unresolved",
      );
    }
    const key = kv[1]!;
    const value = kv[2]!;
    if (value.startsWith("[")) {
      inArray = !value.endsWith("]");
      continue;
    }
    if (key !== "name" && key !== "version" && key !== "source" && key !== "checksum") continue;
    const str = value.match(/^"([^"\\]*)"$/);
    if (!str) {
      throw new DependencyPrefetchError(
        `Cargo.lock ${key} is not a plain string: ${value.slice(0, 80)}`,
        "dependencies_unresolved",
      );
    }
    current[key] = str[1]!;
  }
  flush();
  return packages;
}

export interface GitDependency {
  /** Clone URL exactly as cargo fetches it (the lockfile source minus `git+`,
   * query and fragment). */
  url: string;
  /** Every commit the lockfile pins from this URL. */
  commits: string[];
  /** Directory name of the mirror under deps/git (one mirror per URL, so one
   * url.insteadOf rewrite per URL). */
  mirrorId: string;
}

export interface RegistryDependency {
  name: string;
  version: string;
  checksum: string;
}

export interface DependencyPlan {
  registry: RegistryDependency[];
  git: GitDependency[];
}

/** Classifies every locked package by source and refuses anything the offline
 * build cannot be given safely. Path dependencies (no source) need nothing. */
export function planDependencies(packages: LockedPackage[]): DependencyPlan {
  const registry = new Map<string, RegistryDependency>();
  const git = new Map<string, GitDependency>();

  for (const pkg of packages) {
    if (!pkg.source) continue;
    if (!CRATE_NAME.test(pkg.name) || !CRATE_VERSION.test(pkg.version)) {
      throw new DependencyPrefetchError(
        `Cargo.lock package ${JSON.stringify(pkg.name)} ${JSON.stringify(pkg.version)} has an invalid name or version.`,
        "dependencies_unresolved",
      );
    }

    if (CRATES_IO_SOURCES.has(pkg.source)) {
      if (!pkg.checksum || !SHA256_HEX.test(pkg.checksum)) {
        throw new DependencyPrefetchError(
          `Cargo.lock has no sha256 checksum for ${pkg.name} ${pkg.version}; regenerate it with a current cargo.`,
          "dependencies_unresolved",
        );
      }
      registry.set(`${pkg.name}@${pkg.version}`, {
        name: pkg.name,
        version: pkg.version,
        checksum: pkg.checksum,
      });
      continue;
    }

    if (pkg.source.startsWith("git+")) {
      const { url, commit } = parseGitSource(pkg.source);
      const dep = git.get(url) ?? {
        url,
        commits: [],
        mirrorId: createHash("sha256").update(url).digest("hex").slice(0, 32),
      };
      if (!dep.commits.includes(commit)) dep.commits.push(commit);
      git.set(url, dep);
      continue;
    }

    throw new DependencyPrefetchError(
      `Unsupported dependency source for ${pkg.name} ${pkg.version}: only crates.io and public https git dependencies can be built offline.`,
      "dependencies_unresolved",
    );
  }

  return { registry: [...registry.values()], git: [...git.values()] };
}

function parseGitSource(source: string): { url: string; commit: string } {
  const spec = source.slice("git+".length);
  const hash = spec.lastIndexOf("#");
  const commit = hash === -1 ? "" : spec.slice(hash + 1);
  if (!GIT_COMMIT.test(commit)) {
    throw new DependencyPrefetchError(
      `Git dependency ${spec.slice(0, 120)} is not pinned to a full commit in Cargo.lock.`,
      "dependencies_unresolved",
    );
  }
  const url = spec.slice(0, hash).split("?")[0]!;
  try {
    new URL(url);
    // The URL is written into a git config value; keep it to plain URL characters.
    if (!/^[A-Za-z0-9._~:/@!$&'()*+,;=%-]+$/.test(url)) throw new Error("charset");
  } catch {
    throw new DependencyPrefetchError(
      `Git dependency URL is not valid: ${url.slice(0, 120)}`,
      "dependencies_unresolved",
    );
  }
  return { url, commit };
}

/** The crates.io index path for a crate (same layout for the sparse index and a
 * cargo local-registry `index/` directory). */
export function indexPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length === 1) return `1/${n}`;
  if (n.length === 2) return `2/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

// --- Guarded network seams ----------------------------------------------------

export interface HttpsResponse {
  status: number;
  body: Buffer;
}

export type FetchHttps = (
  url: URL,
  pin: ResolvedPin | undefined,
  opts: { maxBytes: number; timeoutMs: number },
) => Promise<HttpsResponse>;

export type RunCommand = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
  env?: Record<string, string>,
) => Promise<{ code: number; out: string; timedOut?: boolean }>;

export interface PrefetchDeps {
  /** SSRF guard; defaults to the same check the repo clone uses. */
  assertUrl?: (url: string) => Promise<ResolvedPin | undefined>;
  /** HTTPS GET pinned to the guard's IP; never follows redirects. */
  fetchHttps?: FetchHttps;
  /** Process runner for git (the executor's `run` seam). */
  run: RunCommand;
  /** Parallel downloads. */
  concurrency?: number;
  /** Free bytes available to this process on the volume containing `dir`;
   * defaults to statfs. Unreadable capacity skips the check (see assertDiskSpace). */
  getFreeBytes?: (dir: string) => Promise<number>;
  /** Overrides for the disk-space estimate. */
  diskSpace?: DiskSpaceEstimate;
}

export interface DiskSpaceEstimate {
  perCrateBytes?: number;
  perGitDependencyBytes?: number;
  safetyMarginBytes?: number;
}

export const defaultGetFreeBytes = async (dir: string): Promise<number> => {
  const fs = await statfs(dir);
  return Number(fs.bavail) * Number(fs.bsize);
};

/** Bytes the pre-fetch is expected to need: per-package allowances plus the
 * safety margin. */
export function estimateRequiredBytes(plan: DependencyPlan, est: DiskSpaceEstimate = {}): number {
  return (
    plan.registry.length * (est.perCrateBytes ?? DEFAULT_ESTIMATED_CRATE_BYTES) +
    plan.git.length * (est.perGitDependencyBytes ?? DEFAULT_ESTIMATED_GIT_DEP_BYTES) +
    (est.safetyMarginBytes ?? DEFAULT_DISK_SAFETY_MARGIN_BYTES)
  );
}

function pinnedLookup(ip: string): LookupFunction {
  const family = isIP(ip);
  return ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
    if (opts?.all) cb(null, [{ address: ip, family }]);
    else cb(null, ip, family);
  }) as unknown as LookupFunction;
}

/** Plain HTTPS GET. The socket connects to the guard-validated IP (no second
 * resolution), TLS still verifies the hostname, redirects are NOT followed (a
 * 30x is just a non-200 status), and the body is capped. */
export const defaultFetchHttps: FetchHttps = (url, pin, { maxBytes, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: pin ? pinnedLookup(pin.ip) : undefined,
        headers: { "user-agent": "vellar-verify-prefetch" },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error(`response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });

async function guarded(
  assertUrl: (url: string) => Promise<ResolvedPin | undefined>,
  url: string,
): Promise<ResolvedPin | undefined> {
  try {
    return await assertUrl(url);
  } catch (err) {
    if (err instanceof RepoUrlError) {
      throw new DependencyPrefetchError(err.message, "repo_url_rejected");
    }
    throw err;
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// --- Pre-fetch ----------------------------------------------------------------

export interface PrefetchResult {
  plan: DependencyPlan;
  /** Human-readable summary for the private build log. */
  log: string;
}

/**
 * Resolves every dependency in `<repoDir>/Cargo.lock` into `depsDir`:
 *   depsDir/registry/index/…        crates.io index lines for the locked versions
 *   depsDir/registry/<n>-<v>.crate  checksum-verified crate archives
 *   depsDir/git/<mirrorId>          bare mirrors holding each locked commit
 * The build mounts depsDir read-only and points cargo at it (see
 * hermeticCargoConfig). Throws DependencyPrefetchError; never partially succeeds.
 */
export async function prefetchCargoDependencies(
  repoDir: string,
  depsDir: string,
  deps: PrefetchDeps,
): Promise<PrefetchResult> {
  let lockText: string;
  try {
    lockText = await readFile(join(repoDir, "Cargo.lock"), "utf8");
  } catch {
    throw new DependencyPrefetchError(
      "Cargo.lock is missing at the repository root; commit it so dependencies can be resolved offline.",
      "dependencies_unresolved",
    );
  }

  const plan = planDependencies(parseCargoLock(lockText));
  const assertUrl = deps.assertUrl ?? assertPublicHttpsRepoUrl;
  const fetchHttps = deps.fetchHttps ?? defaultFetchHttps;
  const registryDir = join(depsDir, "registry");
  await mkdir(join(registryDir, "index"), { recursive: true });
  await mkdir(join(depsDir, "git"), { recursive: true });

  const diskNote = await assertDiskSpace(plan, depsDir, deps);

  // Fixed hosts: validated once per pre-fetch, then every request is pinned to
  // the validated address.
  let indexPin: ResolvedPin | undefined;
  let downloadPin: ResolvedPin | undefined;
  if (plan.registry.length > 0) {
    indexPin = await guarded(assertUrl, `${CRATES_IO_INDEX}/`);
    downloadPin = await guarded(assertUrl, `${CRATES_IO_DOWNLOAD}/`);
  }

  const get = async (url: string, pin: ResolvedPin | undefined, maxBytes: number, what: string) => {
    let res: HttpsResponse;
    try {
      res = await fetchHttps(new URL(url), pin, { maxBytes, timeoutMs: FETCH_TIMEOUT_MS });
    } catch (err) {
      throw new DependencyPrefetchError(
        `Fetching ${what} failed: ${err instanceof Error ? err.message : String(err)}`,
        "dependency_fetch_failed",
      );
    }
    if (res.status === 404) {
      throw new DependencyPrefetchError(
        `${what} does not exist on crates.io.`,
        "dependencies_unresolved",
      );
    }
    if (res.status !== 200) {
      throw new DependencyPrefetchError(
        `Fetching ${what} returned HTTP ${res.status}.`,
        res.status >= 500 || res.status === 429
          ? "dependency_fetch_failed"
          : "dependencies_unresolved",
      );
    }
    return res.body;
  };

  // Index: one file per crate name, keeping only the locked versions' lines.
  const byName = new Map<string, RegistryDependency[]>();
  for (const dep of plan.registry) {
    const list = byName.get(dep.name) ?? [];
    list.push(dep);
    byName.set(dep.name, list);
  }
  const concurrency = deps.concurrency ?? 8;
  await mapLimit([...byName.entries()], concurrency, async ([name, versions]) => {
    const path = indexPath(name);
    const body = await get(
      `${CRATES_IO_INDEX}/${path}`,
      indexPin,
      MAX_INDEX_BYTES,
      `index entry for ${name}`,
    );
    const kept: string[] = [];
    for (const dep of versions) {
      const line = body
        .toString("utf8")
        .split("\n")
        .find((l) => {
          try {
            return (JSON.parse(l) as { vers?: string }).vers === dep.version;
          } catch {
            return false;
          }
        });
      if (!line) {
        throw new DependencyPrefetchError(
          `${dep.name} ${dep.version} is not published on crates.io.`,
          "dependencies_unresolved",
        );
      }
      const entry = JSON.parse(line) as { name?: string; cksum?: string };
      if (entry.cksum !== dep.checksum || entry.name?.toLowerCase() !== name.toLowerCase()) {
        throw new DependencyPrefetchError(
          `Cargo.lock checksum for ${dep.name} ${dep.version} does not match crates.io.`,
          "dependencies_unresolved",
        );
      }
      kept.push(line);
    }
    const file = join(registryDir, "index", path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, `${kept.join("\n")}\n`);
  });

  // Crate archives, each verified against the lockfile checksum.
  await mapLimit(plan.registry, concurrency, async (dep) => {
    const url = `${CRATES_IO_DOWNLOAD}/${dep.name}/${dep.name}-${dep.version}.crate`;
    const body = await get(url, downloadPin, MAX_CRATE_BYTES, `${dep.name} ${dep.version}`);
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== dep.checksum) {
      throw new DependencyPrefetchError(
        `Downloaded ${dep.name} ${dep.version} does not match the Cargo.lock checksum.`,
        "dependencies_unresolved",
      );
    }
    await writeFile(join(registryDir, `${dep.name}-${dep.version}.crate`), body);
  });

  // Git dependencies: guarded, pinned, redirect-free fetch of the exact commit.
  for (const dep of plan.git) {
    await mirrorGitDependency(dep, join(depsDir, "git", dep.mirrorId), assertUrl, deps.run);
  }

  return {
    plan,
    log:
      `[prefetch] ${plan.registry.length} crates.io package(s), ${plan.git.length} git dependency(ies) resolved from Cargo.lock` +
      (diskNote ? `\n${diskNote}` : ""),
  };
}

/**
 * Fails fast, before any download, when the volume cannot hold the estimated
 * dependency tree. Free space must be strictly greater than the requirement:
 * a fetch that would land exactly on zero free bytes leaves nothing for the
 * build that follows, so the boundary counts as insufficient. If capacity
 * cannot be read the check is skipped (returning a note for the build log) —
 * an unmeasurable volume must not block builds that would have fit.
 */
async function assertDiskSpace(
  plan: DependencyPlan,
  depsDir: string,
  deps: PrefetchDeps,
): Promise<string | undefined> {
  if (plan.registry.length === 0 && plan.git.length === 0) return undefined;
  const required = estimateRequiredBytes(plan, deps.diskSpace);
  let free: number;
  try {
    free = await (deps.getFreeBytes ?? defaultGetFreeBytes)(depsDir);
    if (!Number.isFinite(free) || free < 0) throw new Error(`invalid free byte count: ${free}`);
  } catch (err) {
    return `[prefetch] disk space check skipped: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (free <= required) {
    throw new DependencyPrefetchError(
      `Insufficient disk space for dependency pre-fetch: ${free} bytes free, more than ${required} bytes required (${plan.registry.length} crates.io package(s), ${plan.git.length} git dependency(ies)).`,
      "insufficient_disk_space",
    );
  }
  return undefined;
}

async function mirrorGitDependency(
  dep: GitDependency,
  mirrorDir: string,
  assertUrl: (url: string) => Promise<ResolvedPin | undefined>,
  run: RunCommand,
): Promise<void> {
  const pin = await guarded(assertUrl, dep.url);
  const git = (args: string[]) =>
    run("git", args, mirrorDir, undefined, { GIT_TERMINAL_PROMPT: "0" });
  const fetch = (refspec: string) =>
    git([
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      ...gitConnectionPinArgs(pin),
      "fetch",
      "--no-tags",
      "--",
      dep.url,
      refspec,
    ]);

  await mkdir(mirrorDir, { recursive: true });
  const init = await git(["init", "--bare", "--quiet"]);
  if (init.code !== 0) {
    throw new DependencyPrefetchError(`git init failed for ${dep.url}`, "dependency_fetch_failed");
  }
  let haveHeads = false;
  for (const [i, commit] of dep.commits.entries()) {
    // Most hosts serve a commit by id; otherwise take the branch heads once and
    // look for it there. Both use the same pinned, redirect-free connection.
    const byId = await fetch(`+${commit}:refs/heads/vellar-locked-${i}`);
    if (byId.code !== 0 && !haveHeads) {
      const heads = await fetch("+refs/heads/*:refs/heads/*");
      if (heads.code !== 0) {
        // Private log only (the message never reaches statusDetail — H3).
        throw new DependencyPrefetchError(
          `git fetch failed for dependency ${dep.url}:\n${byId.out}\n${heads.out}`.trim(),
          "dependency_fetch_failed",
        );
      }
      haveHeads = true;
    }
    const has = await git(["cat-file", "-e", `${commit}^{commit}`]);
    if (has.code !== 0) {
      throw new DependencyPrefetchError(
        `Commit ${commit} of ${dep.url} could not be fetched.`,
        "dependencies_unresolved",
      );
    }
    // cargo updates a git dependency's submodules from URLs inside the
    // dependency itself. Those are not in Cargo.lock and cannot be guarded
    // here, so refuse rather than let the build reach for them.
    const submodules = await git(["cat-file", "-e", `${commit}:.gitmodules`]);
    if (submodules.code === 0) {
      throw new DependencyPrefetchError(
        `Git dependency ${dep.url} uses submodules, which cannot be fetched for an offline build.`,
        "dependencies_unresolved",
      );
    }
    await git(["update-ref", `refs/heads/vellar-locked-${i}`, commit]);
  }
  // cargo asks the mirror for the locked commit by id.
  await git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
}

// --- Build wiring -------------------------------------------------------------

/** Where the build container sees the pre-fetched deps. */
export const CONTAINER_DEPS_DIR = "/deps";

/** cargo config for the offline build: crates.io is replaced by the local
 * registry, and git dependencies are fetched with the git CLI so the
 * url.insteadOf rewrites from hermeticGitConfig apply. */
export function hermeticCargoConfig(): string {
  return [
    "[source.crates-io]",
    'replace-with = "vellar-prefetched"',
    "",
    "[source.vellar-prefetched]",
    `local-registry = "${CONTAINER_DEPS_DIR}/registry"`,
    "",
    "[net]",
    "git-fetch-with-cli = true",
    "",
  ].join("\n");
}

/** Global git config for the build container, written to /deps (read-only in
 * the container, so the build cannot edit it). Every locked git URL is
 * rewritten to its local mirror and only the file transport is allowed, so even
 * without --network=none git has nowhere else to go. A file rather than
 * GIT_CONFIG_* env because git strips that env from the local upload-pack it
 * spawns for file:// fetches. */
export function hermeticGitConfig(plan: DependencyPlan): string {
  const lines = [
    "[protocol]",
    "\tallow = never",
    '[protocol "file"]',
    "\tallow = always",
    // Mirrors are written by the worker, not the container user.
    "[safe]",
    "\tdirectory = *",
  ];
  for (const dep of plan.git) {
    lines.push(`[url "file://${CONTAINER_DEPS_DIR}/git/${dep.mirrorId}"]`);
    lines.push(`\tinsteadOf = "${dep.url}"`);
  }
  return `${lines.join("\n")}\n`;
}

/** Container env that points git at hermeticGitConfig and nothing else. */
export const HERMETIC_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: `${CONTAINER_DEPS_DIR}/gitconfig`,
  GIT_CONFIG_NOSYSTEM: "1",
};
