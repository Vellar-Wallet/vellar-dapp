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

/** Parse a valid IPv6 literal (as accepted by `isIP`) into its eight 16-bit
 * groups. Handles `::` compression, an embedded dotted-quad tail, any letter
 * case, zero-padding, and a trailing `%zone` id. Returns undefined if the text
 * is not a well-formed address, which the caller treats as blocked. */
function ipv6Groups(ip: string): number[] | undefined {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // A dotted-quad tail (`::ffff:127.0.0.1`) stands for the last two groups.
  const tail = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const octets = [tail[2], tail[3], tail[4], tail[5]].map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o > 255)) return undefined;
    const [a, b, c, d] = octets as [number, number, number, number];
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups = part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    return groups.some(Number.isNaN) ? undefined : groups;
  };
  const head = parse(halves[0] ?? "");
  const rest = parse(halves[1] ?? "");
  if (!head || !rest) return undefined;

  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

/** The IPv4 address held in two 16-bit groups, as dotted-quad text. */
function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True when an IP literal is loopback, private, link-local, or otherwise not a
 * public routable address that the build host should ever fetch from. An IPv6
 * literal that EMBEDS an IPv4 address (mapped, NAT64, SIIT, 6to4) is judged by
 * that IPv4 address; this works on the parsed 128 bits, never on the text, so
 * hex / expanded / padded / upper-case spellings cannot slip past (RA-7). */
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
    const g = ipv6Groups(ip);
    if (!g) return true; // isIP said v6 but we could not parse it: fail closed
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const upperFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

    if (upperFiveZero && g5 === 0) return true; // ::/96 — unspecified, loopback, deprecated IPv4-compatible
    if (upperFiveZero && g5 === 0xffff) return isBlockedAddress(v4FromGroups(g6, g7)); // ::ffff:0:0/96 IPv4-mapped
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
      return isBlockedAddress(v4FromGroups(g6, g7)); // ::ffff:0:0:0/96 IPv4-translated (SIIT)
    }
    if (g0 === 0x64 && g1 === 0xff9b) {
      if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
        return isBlockedAddress(v4FromGroups(g6, g7)); // 64:ff9b::/96 NAT64
      }
      if (g2 === 1) return true; // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
    }
    if (g0 === 0x2002) return isBlockedAddress(v4FromGroups(g1, g2)); // 2002::/16 6to4
    if (g0 === 0x2001 && g1 === 0) return true; // 2001::/32 Teredo
    if (g0 === 0x2001 && g1 === 0xdb8) return true; // 2001:db8::/32 documentation
    if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard-only
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  // Not a parseable IP literal — treat as blocked (caller resolves hostnames).
  return true;
}

export interface RepoUrlGuardDeps {
  /** Resolve a hostname to IP strings. Injectable for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
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

/** Full guard: https-only + EVERY resolved address must be public. Throws
 * RepoUrlError otherwise. Returns the validated pin (host:port:ip) so the caller
 * can force git to connect to the exact address the guard checked — closing the
 * window where git would otherwise resolve the hostname again independently.
 * Undefined for an IP-literal host (the host is already the checked address). */
export async function assertPublicHttpsRepoUrl(
  repoUrl: string,
  deps: RepoUrlGuardDeps = {},
): Promise<ResolvedPin | undefined> {
  const url = parseHttpsRepoUrl(repoUrl);
  const resolve = deps.resolve ?? defaultResolve;
  const port = url.port ? Number(url.port) : 443;

  // If the host is already an IP literal, check it directly. No pin: git will
  // connect to that literal, which is the exact value we validated.
  if (isIP(url.hostname)) {
    if (isBlockedAddress(url.hostname)) {
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
