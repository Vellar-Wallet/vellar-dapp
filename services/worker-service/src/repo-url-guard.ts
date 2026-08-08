import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

// repoUrl SSRF guard (security-audit.md H2/H3/FIX 6). The worker clones a
// submitter-supplied repoUrl on the HOST (outside the --network=none build
// sandbox), so an unrestricted URL reaches cloud metadata, RFC1918 hosts, and
// loopback services. This restricts the clone target to public https, and —
// critically — re-resolves DNS right before the clone and rejects any answer in
// a private/loopback/link-local range, defeating DNS-rebinding.

export class RepoUrlError extends Error {
  readonly code = "repo_url_rejected";
  constructor(message: string) {
    super(message);
    this.name = "RepoUrlError";
  }
}

/** Parse + syntactic checks: https only, no userinfo. Throws RepoUrlError. */
export function parseHttpsRepoUrl(repoUrl: string): URL {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new RepoUrlError(`repoUrl is not a valid URL: ${repoUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new RepoUrlError(
      `repoUrl must use https (got ${url.protocol}); file/git/ssh/http are blocked.`,
    );
  }
  if (url.username || url.password) {
    throw new RepoUrlError("repoUrl must not embed credentials (userinfo).");
  }
  return url;
}

/** True when an IP literal is loopback, private, link-local, or otherwise not a
 * public routable address that the build host should ever fetch from. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
      return true;
    const a = parts[0] as number;
    const b = parts[1] as number;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8 private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
    if (a === 192 && b === 168) return true; // 192.168/16 private
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped ::ffff:a.b.c.d — re-check the embedded v4.
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped && mapped[1]) return isBlockedAddress(mapped[1]);
    return false;
  }
  // Not a parseable IP literal — treat as blocked (caller resolves hostnames).
  return true;
}

export interface RepoUrlGuardDeps {
  /** Resolve a hostname to IP strings. Injectable for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

/** Full guard: https-only + every resolved address must be public. Throws
 * RepoUrlError otherwise. Run this immediately before the clone so the checked
 * resolution is the one git will use (rebinding defense). */
export async function assertPublicHttpsRepoUrl(
  repoUrl: string,
  deps: RepoUrlGuardDeps = {},
): Promise<void> {
  const url = parseHttpsRepoUrl(repoUrl);
  const resolve = deps.resolve ?? defaultResolve;

  // If the host is already an IP literal, check it directly.
  if (isIP(url.hostname)) {
    if (isBlockedAddress(url.hostname)) {
      throw new RepoUrlError(
        `repoUrl host ${url.hostname} is a private/loopback/link-local address.`,
      );
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolve(url.hostname);
  } catch (err) {
    throw new RepoUrlError(
      `repoUrl host ${url.hostname} could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new RepoUrlError(`repoUrl host ${url.hostname} did not resolve to any address.`);
  }
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new RepoUrlError(
        `repoUrl host ${url.hostname} resolves to a blocked address (${addr}).`,
      );
    }
  }
}
