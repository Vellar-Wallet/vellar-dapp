import { createHash } from "node:crypto";
import { Address, TransactionBuilder } from "@stellar/stellar-sdk";
import { addressCredentials } from "./scope";

// Replay protection for the sponsor-submission path (technical-doc.md §8,
// idea.md §12; security-audit.md C1/H1/RA-2 family).
//
// REPLAY IDENTITY. A sponsored submission is NOT protected by the envelope's
// sequence number: createSponsorSubmitter discards the caller's envelope and
// rebuilds {func, auth} around the SPONSOR's account, and the relayer path
// likewise re-sources. Anything derived from the envelope (tx hash, source,
// sequence, fee, memo, time bounds) can be changed freely by whoever holds a
// copy of the signed auth, so keying on it would be bypassable by re-wrapping.
//
// What the wallet actually signs, and what the chain itself uses for replay
// protection, is each address-credential SorobanAuthorizationEntry: its `nonce`
// is unique per (address, nonce) until `signatureExpirationLedger`, and the host
// rejects a second use. So the replay key is
//     (server-config network, credential address, nonce)
// one key per address-credential entry. A submission is a replay if ANY of its
// keys has been reserved before. Distinct signing ceremonies draw fresh random
// nonces (passkey-kit), so distinct legitimate submissions never collide.
//
// Why the chain's own nonce check is not enough: the sponsor pays for (and the
// budget meters) everything up to and including the on-chain failure. A copy
// replayed before the original lands passes simulation, consumes budget, gets
// signed and sent, and only then fails on-chain, at Vellar's expense. N
// concurrent copies cost N fees. The reservation closes that window, and it runs
// BEFORE the submitter so a replay can never reach consumeSponsorBudget.
//
// ALL-OR-NOTHING. A tx can carry several auth entries. Reserving them one by one
// would let a replay that shares ONE already-reserved entry leave its OTHER
// entries reserved, locking their legitimate signer out. reserve() therefore
// takes the whole set atomically: if any key is already reserved it reserves none.
//
// RETENTION. After `signatureExpirationLedger` the host rejects the entry
// outright (simulation fails before any budget is consumed), so a reservation
// only has to outlive its expiration ledger. The route additionally refuses any
// entry whose expiration is further than MAX_AUTH_EXPIRATION_LEDGERS ahead of
// the current ledger, which bounds both retention and table size.
// purgeExpired(ledger) deletes rows whose expiration ledger is strictly below
// the current ledger.

/** Default cap on how far ahead of the current ledger an auth entry may expire
 * (~10 minutes at ~5s per ledger). 20x the passkey-kit default window of 6
 * ledgers, 2x the extension's 60-ledger cap (L4), above vellar-sdk's x402 58. */
export const DEFAULT_MAX_AUTH_EXPIRATION_LEDGERS = 120;

/** Parses MAX_AUTH_EXPIRATION_LEDGERS. Unset or blank gives the default; anything
 * that is not a plain positive safe integer THROWS so a typo fails the boot. */
export function maxAuthExpirationLedgersFromEnv(raw: string | undefined): number {
  const text = raw?.trim() ?? "";
  if (text === "") return DEFAULT_MAX_AUTH_EXPIRATION_LEDGERS;
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `MAX_AUTH_EXPIRATION_LEDGERS must be a positive integer number of ledgers, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export interface ReplayKey {
  /** Credential subject (C-/G-address strkey). */
  address: string;
  /** Int64 nonce as a decimal string (exact; no float rounding). */
  nonce: string;
  signatureExpirationLedger: number;
}

/** Every address-credential replay key in a signed tx, de-duplicated on
 * (address, nonce). Returns [] for an unparseable tx or one with no
 * address-credential auth entries (the route's scope gate already rejects
 * those before this runs). Fee-bump envelopes carry no operations and yield []. */
export function extractReplayKeys(signedXdr: string, networkPassphrase: string): ReplayKey[] {
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    return [];
  }
  if (!("operations" in tx)) return [];

  const keys = new Map<string, ReplayKey>();
  for (const op of tx.operations) {
    if (op.type !== "invokeHostFunction" || !op.auth) continue;
    for (const entry of op.auth) {
      const creds = addressCredentials(entry.credentials());
      if (!creds) continue;
      const key: ReplayKey = {
        address: Address.fromScAddress(creds.address()).toString(),
        nonce: creds.nonce().toString(),
        signatureExpirationLedger: creds.signatureExpirationLedger(),
      };
      keys.set(`${key.address}:${key.nonce}`, key);
    }
  }
  return [...keys.values()];
}

/** A short, non-reversible fingerprint of a key set for audit/log correlation.
 * Order-independent so the same auth set always maps to the same value. */
export function replayFingerprint(keys: ReplayKey[]): string {
  const canonical = keys
    .map((k) => `${k.address}:${k.nonce}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export type ReserveResult = { ok: true } | { ok: false; reason: "replay" };

export interface ReplayGuard {
  /** Atomically reserve ALL keys, or none. Returns {ok:false} when any key is
   * already reserved (a replay); THROWS when the reservation cannot be
   * recorded. Callers must treat a throw as "refuse" (fail closed). */
  reserve(keys: ReplayKey[]): Promise<ReserveResult>;
  /** Drop a reservation. Only for failures that provably happened before the
   * transaction could land (see RELEASABLE_SUBMISSION_CODES). */
  release(keys: ReplayKey[]): Promise<void>;
  /** Delete reservations whose expiration ledger is strictly below
   * `currentLedger`; the host rejects those entries on its own. */
  purgeExpired(currentLedger: number): Promise<void>;
}

/** Submitter failure codes raised when the tx DEFINITELY did not land: nothing
 * was sent, or the network refused it before inclusion (sendTransaction ERROR /
 * TRY_AGAIN_LATER). Releasing on these lets the owner retry the same signed auth.
 * Every other failure keeps the reservation: once a send may have happened, only
 * the chain knows whether the nonce is spent, and a retry must be a fresh
 * signature. An unrecognised code is NOT releasable. */
export const RELEASABLE_SUBMISSION_CODES: ReadonlySet<string> = new Set([
  "relayer_not_configured",
  "sponsor_bad_tx",
  "sponsor_simulation_failed",
  "sponsor_fee_too_high",
  "sponsor_budget_exceeded",
  "sponsor_try_again_later",
  "sponsor_submit_failed",
]);

/** In-memory guard for dev / tests. Single-process only; production runs the
 * Postgres guard (persistence policy refuses to boot in-memory in prod). */
export function createMemoryReplayGuard(): ReplayGuard {
  const reserved = new Map<string, number>();
  const id = (k: ReplayKey) => `${k.address}:${k.nonce}`;
  return {
    // No await between the check and the writes, so concurrent callers on one
    // event loop cannot interleave: the whole set is taken atomically.
    async reserve(keys) {
      if (keys.some((k) => reserved.has(id(k)))) return { ok: false, reason: "replay" };
      for (const k of keys) reserved.set(id(k), k.signatureExpirationLedger);
      return { ok: true };
    },
    async release(keys) {
      for (const k of keys) reserved.delete(id(k));
    },
    async purgeExpired(currentLedger) {
      for (const [key, expiration] of reserved) {
        if (expiration < currentLedger) reserved.delete(key);
      }
    },
  };
}
