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
  if (url.origin !== value) return undefined; // must be a bare origin, no path/query
  return url.origin;
}

export function hasCapability(
  grants: readonly PermissionGrant[],
  origin: string,
  network: string,
  capability: Capability,
): boolean {
  return grants.some(
    (g) => g.origin === origin && g.network === network && g.capabilities.includes(capability),
  );
}
