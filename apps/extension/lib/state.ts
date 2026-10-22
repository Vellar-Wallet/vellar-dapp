import { z } from "zod";
import { networkSchema, permissionGrantSchema, type PermissionGrant } from "@vellar/provider-sdk";

// Extension-local state (technical-doc.md §8.2: store minimal sensitive local
// state). Holds ONLY the paired wallet identity (public address + network) and
// per-origin permission grants — never key material. Injectable KV seam so
// the logic is unit-testable; browser.storage.local backs it in production.

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** Exported so callers can watch for live changes (e.g. browser.storage.onChanged
 * in App.tsx, #588) without duplicating the key literal. */
export const STATE_KEY = "vela.extension.state";

export const pairedWalletSchema = z.object({
  address: z.string().min(1),
  network: networkSchema,
  /** Soroban RPC endpoint for this wallet's network (from pairing). */
  rpcUrl: z.string().min(1),
  /** Passkey credential id (public) — attaches the kit without a ceremony. */
  keyId: z.string().min(1),
  /** Canonical smart-wallet wasm hash (kit constructor requirement). */
  walletWasmHash: z.string().min(1),
  /** The web app's origin, captured from the TRUSTED pairing sender — powers
   * the deep-link handoff (§4.2). Optional for pre-existing pairings. */
  webAppOrigin: z.string().min(1).optional(),
});

export type PairedWallet = z.infer<typeof pairedWalletSchema>;

const stateSchema = z.object({
  pairedWallet: pairedWalletSchema.optional(),
  grants: z.array(permissionGrantSchema),
});

export type ExtensionState = z.infer<typeof stateSchema>;

const EMPTY_STATE: ExtensionState = { grants: [] };

/** #579: an upper bound on how many distinct dApp origins may be paired
 * (connect-granted) to one wallet at a time — without this, the "Connected
 * dApps" list has no ceiling, which degrades the approval/review UI and makes
 * auditing paired origins impractical at scale. Grants on multiple networks
 * for the SAME origin count once (it is one paired site, not two). */
export const MAX_PAIRED_ORIGINS = 50;

/** Thrown by addGrant when pairing a NEW origin would exceed MAX_PAIRED_ORIGINS. */
export class PairedOriginLimitError extends Error {
  readonly code = "paired_origin_limit_reached";
  constructor(limit: number) {
    super(
      `This wallet already has ${limit} paired dApp origins, the maximum allowed. ` +
        "Unpair (revoke) an origin you no longer use before connecting a new one.",
    );
    this.name = "PairedOriginLimitError";
  }
}

/** Corrupt/legacy storage resolves to empty state, never a crash. */
export async function loadState(kv: KeyValueStore): Promise<ExtensionState> {
  try {
    const raw = await kv.get(STATE_KEY);
    const parsed = stateSchema.safeParse(raw);
    return parsed.success ? parsed.data : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

async function saveState(kv: KeyValueStore, state: ExtensionState): Promise<void> {
  await kv.set(STATE_KEY, state);
}

export async function setPairedWallet(kv: KeyValueStore, wallet: PairedWallet): Promise<void> {
  const state = await loadState(kv);
  // Pairing a different wallet invalidates grants made for the previous one.
  const grants = state.pairedWallet?.address === wallet.address ? state.grants : [];
  await saveState(kv, { pairedWallet: wallet, grants });
}

export async function clearPairedWallet(kv: KeyValueStore): Promise<void> {
  await saveState(kv, EMPTY_STATE);
}

/**
 * Adds or replaces the grant for the origin+network. Rejects pairing a NEW
 * origin once MAX_PAIRED_ORIGINS distinct origins are already paired (#579);
 * a grant that only replaces/extends an ALREADY-paired origin (e.g. a new
 * network for a site you already connected) is never blocked by the limit —
 * exactly reaching the limit on the last allowed new origin still succeeds.
 */
export async function addGrant(kv: KeyValueStore, grant: PermissionGrant): Promise<void> {
  const state = await loadState(kv);
  const isNewOrigin = !state.grants.some((g) => g.origin === grant.origin);
  if (isNewOrigin) {
    const distinctOrigins = new Set(state.grants.map((g) => g.origin));
    if (distinctOrigins.size >= MAX_PAIRED_ORIGINS) {
      throw new PairedOriginLimitError(MAX_PAIRED_ORIGINS);
    }
  }
  const grants = state.grants.filter(
    (g) => !(g.origin === grant.origin && g.network === grant.network),
  );
  await saveState(kv, { ...state, grants: [...grants, grant] });
}

/** Revokes the grant for origin+network; false when nothing was granted. */
export async function revokeGrant(
  kv: KeyValueStore,
  origin: string,
  network: string,
): Promise<boolean> {
  const state = await loadState(kv);
  const grants = state.grants.filter((g) => !(g.origin === origin && g.network === network));
  if (grants.length === state.grants.length) return false;
  await saveState(kv, { ...state, grants });
  return true;
}
