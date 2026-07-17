import { z } from "zod";
import { networkSchema, permissionGrantSchema, type PermissionGrant } from "@vela/provider-sdk";

// Extension-local state (technical-doc.md §8.2: store minimal sensitive local
// state). Holds ONLY the paired wallet identity (public address + network) and
// per-origin permission grants — never key material. Injectable KV seam so
// the logic is unit-testable; browser.storage.local backs it in production.

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const STATE_KEY = "vela.extension.state";

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

/** Adds or replaces the grant for the origin+network. */
export async function addGrant(kv: KeyValueStore, grant: PermissionGrant): Promise<void> {
  const state = await loadState(kv);
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
