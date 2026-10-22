import type { PolicyDefinition } from "@vellar/types";
import type { VerificationStatus } from "@vellar/verification-sdk";

// Verified-only signing (#398) — wallet-side half.
//
// The three modes and WHERE each is enforced:
//
//   strict              — ON-CHAIN. A `verified_only` policy instance
//                         (contracts/policy-templates/verified-recipient,
//                         ProvenanceMode::Strict) is attached to the account as
//                         a standalone policy signer; the wallet consults it in
//                         __check_auth and REJECTS any authorization that
//                         invokes a contract without a live attestation.
//   trusted_publishers  — ON-CHAIN, same contract in
//                         ProvenanceMode::TrustedPublishers(set): only
//                         attestations attributed to the configured publishers
//                         pass.
//   warn                — WALLET-SIDE ONLY. No policy is attached; before the
//                         passkey prompt the send flow looks the target up and
//                         shows a provenance warning, then lets the user
//                         proceed. This is a signal, not a control.
//
// The mode preference itself is per-account display state (localStorage): the
// on-chain policy signer is the truth for strict/trusted (it shows up in the
// signer list and is detached from there — the recovery path), and warn is by
// construction a client behaviour.
//
// Honesty bar (technical-doc.md §15.1, design-provenance-gated-spending.md):
// "verified" means REPRODUCIBLE, ATTRIBUTABLE SOURCE PROVENANCE — the deployed
// bytes were rebuilt from inspectable source. It does not mean audited,
// benign, free of vulnerabilities, or upgrade-safe. Copy in this module and in
// the UI must say provenance, never safety.

export type ProvenanceMode = "off" | "warn" | "strict" | "trusted_publishers";

const prefKey = (accountId: string) => `vellar.provenance.${accountId}`;

export interface ProvenancePreference {
  mode: ProvenanceMode;
  trustedPublishers?: string[];
}

export function readProvenancePreference(accountId: string): ProvenancePreference {
  try {
    const raw = window.localStorage.getItem(prefKey(accountId));
    if (!raw) return { mode: "off" };
    const parsed = JSON.parse(raw) as ProvenancePreference;
    if (!["off", "warn", "strict", "trusted_publishers"].includes(parsed.mode))
      return { mode: "off" };
    return parsed;
  } catch {
    return { mode: "off" };
  }
}

export function writeProvenancePreference(accountId: string, pref: ProvenancePreference): void {
  try {
    window.localStorage.setItem(prefKey(accountId), JSON.stringify(pref));
  } catch {
    // Display preference only; the on-chain policy is the control.
  }
}

/** The policy-service definition for an on-chain provenance mode. */
export function provenancePolicyDefinition(
  owner: string,
  mode: "strict" | "trusted_publishers",
  trustedPublishers: string[] = [],
): PolicyDefinition {
  return {
    version: "1",
    type: "verified_only",
    owners: [owner],
    provenance:
      mode === "strict" ? { mode: "strict" } : { mode: "trusted_publishers", trustedPublishers },
  };
}

// --- Warn mode: the pre-signing provenance look-up ---------------------------

export type ProvenanceLevel =
  /** A live "verified" record exists for the contract's current wasm hash. */
  | "verified"
  /** The contract has no verified record (unverified, failed, or unknown). */
  | "unverified"
  /** A verified record exists, but it covers a wasm hash the contract has since
   * been upgraded away from. Meaningfully different from verified (the bytes
   * running now were never reproduced) and from unverified (source was
   * reproduced once, just not for what is deployed now). */
  | "stale"
  /** Native asset contract: built into the network, no source to reproduce. */
  | "builtin"
  /** The recipient is a classic G-account: no code to verify. */
  | "no-code"
  /** The verification service could not be reached — unknown, not verified. */
  | "unavailable";

export interface ProvenanceAssessment {
  level: ProvenanceLevel;
  contractId?: string;
  status?: VerificationStatus;
}

export interface ProvenanceLookup {
  getStatus(contractId: string): Promise<{
    status: VerificationStatus;
    /** Wasm hash the current verification record covers (its build output). */
    verifiedHash?: string | null;
    /** Wasm hash currently deployed on-chain for this contract. */
    onChainHash?: string | null;
  }>;
}

/** Assess the target of a payment. `contractId` is the contract whose code the
 * authorization will run through (the token contract, or a C-address payee). */
export async function assessProvenance(
  target: { contractId: string; isNativeAsset?: boolean } | { classicAccount: string },
  lookup: ProvenanceLookup,
): Promise<ProvenanceAssessment> {
  if ("classicAccount" in target) return { level: "no-code" };
  if (target.isNativeAsset) return { level: "builtin", contractId: target.contractId };
  try {
    const { status, verifiedHash, onChainHash } = await lookup.getStatus(target.contractId);
    if (status !== "verified") {
      return { level: "unverified", contractId: target.contractId, status };
    }
    // A "verified" record is only about the bytes it was built against. If the
    // contract was upgraded on-chain past that hash, the running code has no
    // reproduced source — unless a later verification covers the new hash, in
    // which case the lookup already reports that record and the hashes match.
    if (verifiedHash && onChainHash && verifiedHash !== onChainHash) {
      return { level: "stale", contractId: target.contractId, status };
    }
    return { level: "verified", contractId: target.contractId, status };
  } catch {
    return { level: "unavailable", contractId: target.contractId };
  }
}

/** Whether warn mode should surface a warning for this assessment. */
export function shouldWarn(pref: ProvenancePreference, a: ProvenanceAssessment): boolean {
  if (pref.mode !== "warn") return false;
  return a.level === "unverified" || a.level === "unavailable" || a.level === "stale";
}

/** Copy for the warn-mode signal. Says provenance, never safety. */
export function provenanceWarningCopy(a: ProvenanceAssessment): string {
  switch (a.level) {
    case "unverified":
      return "This contract has no verified source provenance: its deployed code has not been reproduced from inspectable source. That is a provenance signal, not a safety verdict — verified code can still be malicious, and unverified code can be fine. Proceed only if you trust the target for other reasons.";
    case "stale":
      return "This contract's verified source provenance covers an older wasm hash than the code now deployed: it was upgraded after verification and the current bytes have not been reproduced. That is a provenance signal, not a safety verdict. Proceed only if you trust the target for other reasons.";
    case "unavailable":
      return "Provenance could not be checked: the verification service is unreachable. Treat the target as unverified; provenance being unknown is not a verdict either way.";
    default:
      return "";
  }
}

/** Decode a strict-mode rejection from a failed transaction. */
export function isProvenanceRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  // The wallet reports a rejecting required policy as MissingContext (110); a
  // rejecting standalone policy surfaces the policy's own error (NotAllowed=1
  // / UntrustedPublisher=6). Callers combine this with the account's mode.
  return /Error\(Contract,\s*#(1|6|110)\)/.test(message);
}
