// Pure signer-set model for the settings page (#401). No browser or chain
// access here so it is unit-testable; the raw rows come from passkey-kit's
// signer indexer (`WalletSigner`) via lib/signers.ts.
//
// The smart wallet stores three signer kinds (smart-wallet-interface
// `SignerKey`): Secp256r1 (a WebAuthn passkey), Ed25519 (a raw key — the
// extension's device session or an agent session key) and Policy (a policy
// contract). The kind alone does not say what a signer IS to the user, so the
// classification below also reads the entry's limits/storage/expiration —
// the same fields the contract reads in `__check_auth`.

export type SignerKeyKind = "Secp256r1" | "Ed25519" | "Policy";

export interface SignerKeyRef {
  kind: SignerKeyKind;
  /** base64url credential id (Secp256r1), G… public key (Ed25519) or C… policy
   * contract id (Policy) — the string form passkey-kit's `SignerKey` uses. */
  value: string;
}

export type SignerKind = "passkey" | "device-session" | "agent" | "policy" | "unknown";

export type SignerStatus = "live" | "expired" | "evicted" | "removed";

/** One `SignerLimits` entry: what the signer may authorize on `contract`, and
 * which co-signers must approve (`null` = none required). */
export interface SignerLimitEntry {
  contract: string;
  requiredCoSigners: SignerKeyRef[] | null;
}

export interface SignerEntry {
  id: string;
  kind: SignerKind;
  key: SignerKeyRef;
  status: SignerStatus;
  storage: "persistent" | "temporary";
  /** ISO timestamp when set (the contract stores unix seconds, inclusive). */
  expiresAt?: string;
  /** `undefined` = unlimited (can authorize anything, incl. wallet admin). */
  limits?: SignerLimitEntry[];
  /** Whether this passkey is the one the current browser session uses. */
  isCurrent: boolean;
  /**
   * Mirrors the wallet contract's `is_durable_admin`: stored Persistent, no
   * expiration, and admin-capable (unlimited, or a limits entry for the
   * wallet's own address with no required co-signers). The contract refuses to
   * remove/demote the LAST such signer (`LastAdminSigner`, error 103) — the
   * on-chain lockout guard the UI mirrors.
   */
  isDurableAdmin: boolean;
}

/** The minimal indexer row shape lib/signers.ts feeds in (structural view of
 * passkey-kit's `WalletSigner`; the SignerKey class is reduced to {key,value}). */
export interface RawSigner {
  key: { key: SignerKeyKind; value: string };
  expiration?: number;
  limits?: Map<string, Array<{ key: SignerKeyKind; value: string }> | undefined> | undefined;
  storage: "persistent" | "temporary";
  status: SignerStatus;
}

export interface ClassifyOptions {
  /** The current session's passkey credential id (base64url). */
  currentKeyId?: string;
  /** The wallet's own contract address (limits entries for it = admin grant). */
  walletAddress: string;
}

export function classifySigner(raw: RawSigner, opts: ClassifyOptions): SignerEntry {
  const key: SignerKeyRef = { kind: raw.key.key, value: raw.key.value };
  const limits = raw.limits
    ? [...raw.limits.entries()].map(([contract, cosigners]) => ({
        contract,
        requiredCoSigners: cosigners
          ? cosigners.map((c) => ({ kind: c.key, value: c.value }))
          : null,
      }))
    : undefined;
  const unlimited = limits === undefined;
  const adminGrant =
    unlimited ||
    limits.some(
      (l) =>
        l.contract === opts.walletAddress &&
        (l.requiredCoSigners === null || l.requiredCoSigners.length === 0),
    );
  const isDurableAdmin = raw.storage === "persistent" && raw.expiration === undefined && adminGrant;

  return {
    id: `${key.kind}:${key.value}`,
    kind: kindOf(raw, unlimited),
    key,
    status: raw.status,
    storage: raw.storage,
    expiresAt:
      raw.expiration === undefined ? undefined : new Date(raw.expiration * 1000).toISOString(),
    limits,
    isCurrent:
      key.kind === "Secp256r1" &&
      opts.currentKeyId !== undefined &&
      key.value === opts.currentKeyId,
    isDurableAdmin,
  };
}

/**
 * Classify a raw signer's key kind into the user-facing `SignerKind`.
 *
 * `raw.key.key`'s declared type (`SignerKeyKind`) is a closed union, but this
 * reads data from the chain indexer — a future signer key type, or malformed
 * indexer output, is not something the type system can rule out at runtime.
 * Falls back to `"unknown"` rather than throwing, so one unrecognized signer
 * never takes down the whole settings page.
 */
function kindOf(raw: RawSigner, unlimited: boolean): SignerKind {
  switch (raw.key.key) {
    case "Secp256r1":
      return "passkey";
    case "Policy":
      return "policy";
    case "Ed25519":
      // The extension pairing adds an UNLIMITED, TEMPORARY, expiring key
      // (connector-factory addDeviceSigner). Anything policy-limited is an
      // agent key; an unlimited persistent Ed25519 is a delegated key with
      // full authority and is surfaced as an agent so it is never mistaken for
      // a bounded session.
      return unlimited && raw.storage === "temporary" ? "device-session" : "agent";
    default:
      return "unknown";
  }
}

/** Classify and order: passkeys, then device sessions, agents, policies, then
 * anything unrecognized last; removed tombstones are dropped (the chain no
 * longer has them). */
export function classifySigners(rows: RawSigner[], opts: ClassifyOptions): SignerEntry[] {
  const order: Record<SignerKind, number> = {
    passkey: 0,
    "device-session": 1,
    agent: 2,
    policy: 3,
    unknown: 4,
  };
  return rows
    .filter((r) => r.status !== "removed")
    .map((r) => classifySigner(r, opts))
    .sort((a, b) => order[a.kind] - order[b.kind] || Number(b.isCurrent) - Number(a.isCurrent));
}

/** Live passkeys that keep the account recoverable. */
export function livePasskeys(entries: SignerEntry[]): SignerEntry[] {
  return entries.filter((e) => e.kind === "passkey" && e.status === "live");
}

/** Whether removing `entry` would leave the account without a human passkey.
 * Counts LIVE passkeys only: an expired/evicted passkey cannot authorize. */
export function isLastPasskey(entry: SignerEntry, entries: SignerEntry[]): boolean {
  if (entry.kind !== "passkey") return false;
  return livePasskeys(entries).filter((e) => e.id !== entry.id).length === 0;
}

export type RevokeVerdict =
  | { allowed: true }
  | { allowed: false; reason: "last-passkey" | "last-durable-admin" | "not-live" };

/**
 * Client-side mirror of the wallet contract's lockout invariants. The contract
 * is the authority (LastAdminSigner = 103 / LastSigner = 104 reject the
 * transaction on-chain); this only lets the UI refuse BEFORE a passkey prompt
 * and explain why. Never used as the security boundary.
 */
export function canRevokeSigner(entry: SignerEntry, entries: SignerEntry[]): RevokeVerdict {
  if (entry.status === "removed") return { allowed: false, reason: "not-live" };
  if (isLastPasskey(entry, entries)) return { allowed: false, reason: "last-passkey" };
  if (
    entry.isDurableAdmin &&
    entries.filter((e) => e.isDurableAdmin && e.id !== entry.id).length === 0
  ) {
    return { allowed: false, reason: "last-durable-admin" };
  }
  return { allowed: true };
}

/** Map a failed wallet transaction to the contract's own reason where the
 * wallet reported one (smart-wallet-interface error codes). */
export function walletContractErrorCode(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = /Error\(Contract,\s*#(\d+)\)/.exec(message);
  return m ? Number(m[1]) : undefined;
}

export function signerMutationErrorMessage(err: unknown, fallback: string): string {
  switch (walletContractErrorCode(err)) {
    case 100:
      return "That signer is no longer on the account — it may have been removed from another device. Refresh the list.";
    case 101:
      return "That signer already exists on the account.";
    case 103:
      return "The account refused this: it would remove the last durable admin signer and lock you out. Add another passkey first.";
    case 104:
      return "The account refused this: it would remove the last durable signer and lock you out. Add another passkey first.";
    case 110:
      return "The account did not accept this authorization. Your passkey may not be permitted to make this change.";
    default:
      return fallback;
  }
}
