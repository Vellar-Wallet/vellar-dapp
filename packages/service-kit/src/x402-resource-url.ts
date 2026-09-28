// Public-URL guard for x402 Bazaar resource registration.
//
// @x402/fastify derives a route's advertised `resource.url` from the INBOUND
// request's own Host header (getUrl() -> `${protocol}://${host}${path}`) when
// no explicit `resource` is passed in route config. Every service here sits
// behind api-gateway's @fastify/http-proxy, which does not rewrite the Host
// header when forwarding — so the downstream service sees the proxy's own
// internal bind address (e.g. "localhost:4002"), not the public one. That
// value gets published verbatim to the public mainnet Bazaar catalog:
// unreachable for every consumer, and a real duplicate-payout risk (an agent
// could settle payment against a resource URL it can never actually call).
//
// This was caught live on /lifecycle/execute (localhost:4002 registered and
// settled against 3 times before being caught — see docs/decisions.md).
// Fix: every route config passes an EXPLICIT `resource` URL built from a
// validated public base, and that base is validated at STARTUP, not
// discovered after the fact from a live catalog query. A misconfiguration
// must break the deploy, not silently poison the public catalog.

export class X402ResourceUrlError extends Error {
  readonly code = "x402_resource_url_invalid";
  constructor(message: string) {
    super(message);
    this.name = "X402ResourceUrlError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/** URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]", "[fe80::1]");
 * strip that once so every check below can match the bare address. */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackOrLocal(hostname: string): boolean {
  const h = stripIpv6Brackets(hostname.toLowerCase());
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (h.endsWith(".local")) return true;
  // Link-local (169.254.0.0/16, fe80::/10) and bare hostnames with no dot
  // (e.g. a Docker/Kubernetes service name) are equally unreachable from
  // outside the private network they resolve in.
  if (h.startsWith("169.254.")) return true;
  if (h.startsWith("fe80:")) return true;
  if (!h.includes(".") && !h.includes(":")) return true;
  return false;
}

function isPrivateRfc1918(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false;
  const octets = parts.map(Number);
  const a = octets[0]!;
  const b = octets[1]!;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export interface ValidatePublicResourceUrlOptions {
  /** Require https:// — always true for stellar:pubnet resources; a public
   * mainnet payment resource must never be advertised over plain http. */
  requireHttps: boolean;
}

/**
 * Validate that `url` is an absolute, publicly-routable URL fit to publish in
 * an x402 Bazaar resource registration. Throws X402ResourceUrlError naming
 * the offending URL and the specific reason — never returns a boolean for the
 * caller to (mis)handle, because the correct response to a bad resource URL
 * is always "refuse to boot", never "log and continue".
 */
export function validatePublicResourceUrl(
  url: string,
  options: ValidatePublicResourceUrlOptions,
): void {
  if (!url || typeof url !== "string" || url.trim() === "") {
    throw new X402ResourceUrlError("x402 resource URL is empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new X402ResourceUrlError(
      `x402 resource URL '${url}' is not an absolute URL (relative paths cannot be published to a public catalog).`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new X402ResourceUrlError(
      `x402 resource URL '${url}' has scheme '${parsed.protocol}' — only http/https are publishable.`,
    );
  }

  if (options.requireHttps && parsed.protocol !== "https:") {
    throw new X402ResourceUrlError(
      `x402 resource URL '${url}' must use https:// for a stellar:pubnet resource (got '${parsed.protocol}').`,
    );
  }

  const hostname = parsed.hostname;
  if (isLoopbackOrLocal(hostname)) {
    throw new X402ResourceUrlError(
      `x402 resource URL '${url}' resolves to a loopback/local address ('${hostname}') — ` +
        "this is the internal bind address, not the public one. Publishing it makes the " +
        "resource unreachable for every consumer of the catalog. Build the resource URL from " +
        "a validated public base (e.g. RENDER_EXTERNAL_URL), not the inbound request's Host header.",
    );
  }

  if (isPrivateRfc1918(hostname)) {
    throw new X402ResourceUrlError(
      `x402 resource URL '${url}' resolves to a private RFC1918 address ('${hostname}') — ` +
        "not reachable from outside this network. Refusing to publish it to a public catalog.",
    );
  }
}

/**
 * Resolve the public base URL a service must use when building its own x402
 * resource URLs. REQUIRED and validated at startup — there is no permissive
 * fallback to a bind host/port, because that fallback is exactly the bug
 * this guard exists to prevent.
 */
export function publicBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PUBLIC_BASE_URL?.trim();
  const renderExternal = env.RENDER_EXTERNAL_URL?.trim();
  const base = explicit || renderExternal;

  if (!base) {
    throw new X402ResourceUrlError(
      "No public base URL configured for x402 resource registration. Set PUBLIC_BASE_URL " +
        "explicitly, or rely on Render's own RENDER_EXTERNAL_URL. Refusing to fall back to the " +
        "local bind host/port — that fallback is what published localhost:4002 to the public " +
        "mainnet Bazaar catalog.",
    );
  }

  validatePublicResourceUrl(base, { requireHttps: true });
  return base.replace(/\/+$/, "");
}
