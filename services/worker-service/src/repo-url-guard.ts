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

/**
 * Deliberate HTTPS port policy for repository clones:
 * Only standard HTTPS (443) and the standard alternate HTTPS port (8443) are
 * permitted. Arbitrary / internal-service ports (e.g. 6379 Redis, 5432 Postgres,
 * 2375 Docker daemon, 9090 Prometheus, 11434 Ollama, 8080 internal HTTP) are
 * rejected before DNS resolution or socket connection so an allowed public host
 * or IPv6 literal cannot be used to probe non-HTTPS services.
 */
export const ALLOWED_HTTPS_PORTS: ReadonlySet<number> = new Set([443, 8443]);

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Parse + syntactic checks: https only, no userinfo, allowed HTTPS port only. Throws RepoUrlError. */
export function parseHttpsRepoUrl(
  repoUrl: string,
  allowedPorts: ReadonlySet<number> = ALLOWED_HTTPS_PORTS,
): URL {
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
  if (url.port !== "") {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !allowedPorts.has(port)) {
      throw new RepoUrlError(
        `repoUrl port ${url.port} is not allowed; only standard HTTPS ports (${Array.from(allowedPorts).join(", ")}) are permitted.`,
      );
    }
  }
  return url;
}

/** True when an IP literal is loopback, private, link-local, or otherwise not a
 * public routable address that the build host should ever fetch from. */
export function isBlockedAddress(ip: string): boolean {
  const normalizedIp = stripIpv6Brackets(ip.trim());
  const kind = isIP(normalizedIp);
  if (kind === 4) {
    const parts = normalizedIp.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
      return true;
    const a = parts[0] as number;
    const b = parts[1] as number;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / shared address space
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
    if (a === 192 && b === 168) return true; // 192.168/16 private
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (kind === 6) {
    const lower = normalizedIp.toLowerCase();
    if (
      lower === "::1" ||
      lower === "::" ||
      /^(0+:){7}0*1$/.test(lower) ||
      /^(0+:){7}0+$/.test(lower)
    ) {
      return true; // loopback / unspecified
    }
    if (/^fe[89ab][0-9a-f]?:/i.test(lower) || lower.startsWith("fe80")) return true; // link-local fe80::/10
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
    if (lower.startsWith("ff")) return true; // multicast ff00::/8
    if (/^0*64:ff9b:/i.test(lower)) return true; // NAT64 well-known prefix 64:ff9b::/96
    // IPv4-mapped ::ffff:a.b.c.d (dotted-quad form) — re-check the embedded v4.
    const mappedDotted = lower.match(/^(?:::ffff:|(?:0+:){5}ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDotted && mappedDotted[1]) return isBlockedAddress(mappedDotted[1]);
    // IPv4-mapped ::ffff:xxxx:yyyy (WHATWG URL canonical hex form, e.g. ::ffff:7f00:1)
    const mappedHex = lower.match(/^(?:::ffff:|(?:0+:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex && mappedHex[1] && mappedHex[2]) {
      const hi = Number.parseInt(mappedHex[1], 16);
      const lo = Number.parseInt(mappedHex[2], 16);
      const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedAddress(ipv4);
    }
    return false;
  }
  // Not a parseable IP literal — treat as blocked (caller resolves hostnames).
  return true;
}

export interface RepoUrlGuardDeps {
  /** Resolve a hostname to IP strings. Injectable for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Override allowed HTTPS ports (defaults to ALLOWED_HTTPS_PORTS: 443, 8443). */
  allowedPorts?: ReadonlySet<number>;
}

/** A validated resolution the caller pins into git's connection so git does not
 * re-resolve the hostname independently (TOCTOU / rebinding close). Undefined
 * when the URL host is already an IP literal (no resolution, nothing to pin). */
export interface ResolvedPin {
  host: string;
  port: number;
  ip: string;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

/** Full guard: https-only + allowed port + EVERY resolved address must be public.
 * Throws RepoUrlError otherwise. Returns the validated pin (host:port:ip) so the caller
 * can force git to connect to the exact address the guard checked — closing the
 * window where git would otherwise resolve the hostname again independently.
 * Undefined for an IP-literal host (the host is already the checked address). */
export async function assertPublicHttpsRepoUrl(
  repoUrl: string,
  deps: RepoUrlGuardDeps = {},
): Promise<ResolvedPin | undefined> {
  const url = parseHttpsRepoUrl(repoUrl, deps.allowedPorts);
  const resolve = deps.resolve ?? defaultResolve;
  const port = url.port ? Number(url.port) : 443;
  const bareHost = stripIpv6Brackets(url.hostname);

  // If the host is already an IPv4 or bracketed IPv6 literal, check it directly.
  // No pin: git will connect to that literal, which is the exact value we validated.
  if (isIP(bareHost)) {
    if (isBlockedAddress(bareHost)) {
      throw new RepoUrlError(
        `repoUrl host ${url.hostname} is a private/loopback/link-local address.`,
      );
    }
    return undefined;
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
  // EVERY resolved address must be public: reject if ANY is blocked, so a
  // multi-homed host that mixes a public and a private A/AAAA record (a
  // rebinding tactic) is refused outright rather than pinned to its public leg.
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new RepoUrlError(
        `repoUrl host ${url.hostname} resolves to a blocked address (${addr}).`,
      );
    }
  }

  // Selection of the pinned address is DELIBERATE, not resolver-order luck:
  // every address above passed the block check, so any is safe to connect to.
  // We pin the first — a single, stable choice. NOTE: git connects to exactly
  // this one IP (curloptResolve gives it no alternates), so if a multi-homed
  // host's first record is unreachable at clone time the clone fails rather than
  // silently falling back to another address. That is intended: a clone failure
  // is a retryable transient, not a reason to remove the pin (removing it
  // reopens the rebinding TOCTOU). If multi-homed reachability becomes a real
  // problem, add all validated IPs (curloptResolve accepts a comma list) — do
  // NOT drop the pin.
  const pinnedIp = addresses[0]!;
  return { host: url.hostname, port, ip: pinnedIp };
}

/** Build the git `-c` args that (a) pin the connection to the guard-validated IP
 * so git does not re-resolve, and (b) forbid redirects so git cannot be sent to
 * a different, unpinned host that it WOULD resolve freely. Pass a null/undefined
 * pin for an IP-literal host (nothing to pin, but redirects are still forbidden). */
export function gitConnectionPinArgs(pin: ResolvedPin | undefined): string[] {
  const args: string[] = [
    // Any redirect (even to the same host) becomes an error, so a 30x to an
    // unpinned host can never trigger a free re-resolution.
    "-c",
    "http.followRedirects=false",
  ];
  if (pin) {
    // libcurl CURLOPT_RESOLVE: substitute the address for host:port. TLS SNI +
    // certificate validation still use `host`, so this does not open a MITM.
    args.push("-c", `http.curloptResolve=${pin.host}:${pin.port}:${pin.ip}`);
  }
  return args;
}
