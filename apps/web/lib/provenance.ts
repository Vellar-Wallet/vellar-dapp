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
  /** A live "verified" record exists matching the contract's current wasm hash. */
  | "verified"
  /** The contract was verified under an older wasm hash, then upgraded to unverified code. */
  | "superseded"
  /** The contract has no verified record (unverified, failed, or unknown). */
  | "unverified"
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
  /** Currently deployed on-chain wasm hash, when known. */
  currentWasmHash?: string;
  /** Wasm hash of the matched or superseded verification record, when known. */
  verifiedWasmHash?: string;
}

export interface ProvenanceStatusResponse {
  status: VerificationStatus;
  /** Wasm hash recorded on the verification record, when returned by the API. */
  deployedHash?: string;
  verifiedWasmHash?: string;
  outputHash?: string;
  /** Current on-chain wasm hash, when reported alongside status. */
  currentWasmHash?: string;
}

export interface ProvenanceHistoryRecord {
  status: VerificationStatus;
  deployedHash?: string;
  outputHash?: string;
  wasmHash?: string;
}

export interface ProvenanceLookup {
  getStatus(contractId: string): Promise<ProvenanceStatusResponse>;
  /** Optional verification history lookup used to inspect prior/subsequent verified wasm hashes. */
  getHistory?(contractId: string): Promise<ProvenanceHistoryRecord[]>;
  /** Optional on-chain wasm hash lookup for the target contract. */
  getCurrentWasmHash?(contractId: string): Promise<string | undefined>;
}

export type ProvenanceTarget =
  | {
      contractId: string;
      isNativeAsset?: boolean;
      /** Current on-chain wasm hash for the contract, when known. */
      currentWasmHash?: string;
      /** Alias for `currentWasmHash`. */
      deployedWasmHash?: string;
    }
  | { classicAccount: string };

function normalizeWasmHash(hash: string | undefined): string | undefined {
  if (!hash) return undefined;
  const trimmed = hash.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase().replace(/^0x/, "");
}

/** Assess the target of a payment. `contractId` is the contract whose code the
 * authorization will run through (the token contract, or a C-address payee). */
export async function assessProvenance(
  target: ProvenanceTarget,
  lookup: ProvenanceLookup,
): Promise<ProvenanceAssessment> {
  if ("classicAccount" in target) return { level: "no-code" };
  if (target.isNativeAsset) return { level: "builtin", contractId: target.contractId };
  try {
    const statusRes = await lookup.getStatus(target.contractId);
    const { status } = statusRes;

    const rawCurrentHash =
      target.currentWasmHash?.trim() ||
      target.deployedWasmHash?.trim() ||
      statusRes.currentWasmHash?.trim() ||
      (lookup.getCurrentWasmHash
        ? (await lookup.getCurrentWasmHash(target.contractId))?.trim()
        : undefined);
    const normalizedCurrent = normalizeWasmHash(rawCurrentHash);

    // Collect verified wasm hashes from the status response and optional history.
    const verifiedHashes: Array<{ raw: string; normalized: string }> = [];
    const addVerifiedHash = (candidate: string | undefined) => {
      const norm = normalizeWasmHash(candidate);
      if (!norm || !candidate) return;
      if (!verifiedHashes.some((h) => h.normalized === norm)) {
        verifiedHashes.push({ raw: candidate.trim(), normalized: norm });
      }
    };

    const statusRecordHash =
      statusRes.verifiedWasmHash ?? statusRes.deployedHash ?? statusRes.outputHash;
    if (status === "verified" && statusRecordHash) {
      addVerifiedHash(statusRecordHash);
    } else if (statusRes.verifiedWasmHash) {
      addVerifiedHash(statusRes.verifiedWasmHash);
    }

    if (lookup.getHistory) {
      const history = await lookup.getHistory(target.contractId);
      for (const rec of history) {
        if (rec.status === "verified") {
          addVerifiedHash(rec.deployedHash ?? rec.outputHash ?? rec.wasmHash);
        }
      }
    }

    if (normalizedCurrent && rawCurrentHash) {
      const matchingVerified = verifiedHashes.find((h) => h.normalized === normalizedCurrent);
      if (matchingVerified) {
        return {
          level: "verified",
          contractId: target.contractId,
          status: "verified",
          currentWasmHash: rawCurrentHash,
          verifiedWasmHash: matchingVerified.raw,
        };
      }

      if (verifiedHashes.length > 0) {
        return {
          level: "superseded",
          contractId: target.contractId,
          status,
          currentWasmHash: rawCurrentHash,
          verifiedWasmHash: verifiedHashes[0]!.raw,
        };
      }

      if (status === "verified") {
        return {
          level: "verified",
          contractId: target.contractId,
          status,
          currentWasmHash: rawCurrentHash,
        };
      }

      return {
        level: "unverified",
        contractId: target.contractId,
        status,
        currentWasmHash: rawCurrentHash,
      };
    }

    return {
      level: status === "verified" ? "verified" : "unverified",
      contractId: target.contractId,
      status,
      ...(verifiedHashes[0] ? { verifiedWasmHash: verifiedHashes[0].raw } : {}),
    };
  } catch {
    return { level: "unavailable", contractId: target.contractId };
  }
}

/** Whether warn mode should surface a warning for this assessment. */
export function shouldWarn(pref: ProvenancePreference, a: ProvenanceAssessment): boolean {
  if (pref.mode !== "warn") return false;
  return a.level === "unverified" || a.level === "superseded" || a.level === "unavailable";
}

/** Copy for the warn-mode signal. Says provenance, never safety. */
export function provenanceWarningCopy(a: ProvenanceAssessment): string {
  switch (a.level) {
    case "superseded":
      return "This contract was previously verified under an older WASM hash, but its deployed code has since been upgraded and the current on-chain bytecode has no verified source provenance. Prior provenance does not carry over across upgrades — proceed only if you trust the upgraded code.";
    case "unverified":
      return "This contract has no verified source provenance: its deployed code has not been reproduced from inspectable source. That is a provenance signal, not a safety verdict — verified code can still be malicious, and unverified code can be fine. Proceed only if you trust the target for other reasons.";
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
