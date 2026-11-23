import { z } from "zod";
import { networkSchema } from "./protocol";

// Per-origin permission model (technical-doc.md §5.3: permissions are stored
// per dApp origin; users can revoke them). Origins are always derived from
// the trusted browser context (content script sender), never from page input.

export const capabilitySchema = z.enum([
  "connect", // origin may see connection state
  "view_address", // origin may read the public account address
  "sign", // origin may request transaction signing (each tx still needs approval)
]);

export type Capability = z.infer<typeof capabilitySchema>;

/** Granted when a user approves a dApp connection (§7.3). */
export const CONNECT_GRANT_CAPABILITIES: readonly Capability[] = [
  "connect",
  "view_address",
  "sign",
];

export const permissionGrantSchema = z.object({
  origin: z.string().min(1),
  accountId: z.string().min(1),
  network: networkSchema,
  capabilities: z.array(capabilitySchema).min(1),
  grantedAt: z.string().min(1),
});

export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

/**
 * Normalizes an origin string ("https://app.example.com"). Rejects anything
 * that isn't a clean http(s) origin — lookalike/garbage origins never reach
 * storage (§8.2 phishing mitigations).
 *
 * A single trailing dot on the host ("app.example.com.") denotes the same FQDN
 * as the dotless form; we collapse it (L5) so the two don't become distinct
 * grant keys. Only ONE trailing dot is stripped — arbitrary garbage is not
 * canonicalized.
 */
export function normalizeOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.origin === "null") return undefined;
  if (url.origin.toLowerCase() !== value.toLowerCase()) return undefined; // must be a bare origin, no path/query
  if (url.hostname.endsWith(".")) {
    // Rebuild the origin with the single trailing dot removed. Set via the URL
    // so the origin string is recomputed consistently (host + port).
    url.hostname = url.hostname.slice(0, -1);
  }
  return url.origin;
}

/**
 * True when a grant for exactly this origin, account AND network carries the
 * capability. `accountId` is required and matched like the other keys, so a
 * grant issued to one wallet can never authorize another — even if a future
 * change stops wiping grants on re-pair, or a grant list ever spans several
 * accounts (#745). Callers pass the currently paired wallet's account id.
 */
export function hasCapability(
  grants: readonly PermissionGrant[],
  origin: string,
  accountId: string,
  network: string,
  capability: Capability,
): boolean {
  return grants.some(
    (g) =>
      g.origin === origin &&
      g.accountId === accountId &&
      g.network === network &&
      g.capabilities.includes(capability),
  );
}
