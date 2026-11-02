// The x402 facilitator's URL is CONFIGURATION, not code.
//
// lifecycle-service and verification-service build an HTTPFacilitatorClient for
// their payment gate. The URL used to be a string literal in each server.ts, so
// retiring a host meant editing source and a missing setting silently fell back
// to whatever was baked in. This reads FACILITATOR_URL and refuses to boot when
// it is unset or unusable, the same stance publicBaseUrlFromEnv takes for the
// public base URL: a payment gate pointed at the wrong facilitator fails open or
// shut in ways nobody notices until money moves.

export class FacilitatorUrlError extends Error {
  readonly code = "facilitator_url_invalid";
  constructor(message: string) {
    super(message);
    this.name = "FacilitatorUrlError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isRenderHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "onrender.com" || host.endsWith(".onrender.com");
}

/**
 * The facilitator base URL from FACILITATOR_URL, normalised (no trailing slash).
 * Throws FacilitatorUrlError when it is unset, not a URL, carries credentials, a
 * query or a fragment, is a retired Render host, or is not https (plain http is
 * allowed only to a loopback host outside production). Messages never echo the
 * raw value, which could contain a secret.
 */
export function facilitatorUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.FACILITATOR_URL?.trim();
  if (!raw) {
    throw new FacilitatorUrlError(
      "FACILITATOR_URL is not set. Set it to the x402 facilitator's https URL; the service " +
        "refuses to boot rather than fall back to a built-in host.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FacilitatorUrlError(
      "FACILITATOR_URL is not a valid absolute URL (expected https://host[/path]).",
    );
  }

  if (url.username || url.password) {
    throw new FacilitatorUrlError("FACILITATOR_URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new FacilitatorUrlError(
      "FACILITATOR_URL must not contain a query string or fragment (give the base URL only).",
    );
  }
  if (isRenderHost(url.hostname)) {
    throw new FacilitatorUrlError(
      "FACILITATOR_URL points at a Render host. Render is retired; use the Railway facilitator URL.",
    );
  }

  const production = env.NODE_ENV === "production";
  const loopbackHttp =
    url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) && !production;
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new FacilitatorUrlError(
      "FACILITATOR_URL must use https (plain http is allowed only to localhost outside production).",
    );
  }

  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}
