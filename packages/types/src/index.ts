// @vellar/types — shared domain types.
// Sourced from idea.md §6 (core interfaces). technical-doc.md governs scope.
// Keep these in sync with the docs; flag any divergence in docs/decisions.md.
//
// Breaking-change convention (#552): any commit that removes or narrows an
// exported type/interface or makes an optional field required MUST include an
// explicit `// BREAKING: <reason>` comment in the diff, enforced by
// `checkBreakingTypeChanges` / `assertBreakingChangeComment`.

export * from "./breaking-change-check";

export type Network = "testnet" | "mainnet";

// --- Passkey Wallet Module (idea.md §6.1) ---

export interface WalletSession {
  accountId: string;
  network: Network;
  connected: boolean;
  authMethod: "passkey";
  createdAt: string;
  lastActiveAt: string;
  /**
   * Server-side session record id (extension beyond idea.md §6.1, in service
   * of technical-doc.md §5.1 device management — lets the UI mark "this device").
   */
  serverSessionId?: string;
  /**
   * The passkey's base64url credential id (extension beyond idea.md §6.1):
   * lets a fresh page resume the kit connection without a WebAuthn prompt
   * (connectWallet({ keyId }) skips the discovery ceremony). Public data.
   */
  keyId?: string;
}

export interface CreateWalletInput {
  username?: string;
  network: Network;
}

export interface SignTransactionInput {
  xdr: string;
  network: Network;
}

// --- Smart Account Policy Builder (idea.md §6.2) ---

export interface PolicyDefinition {
  version: string;
  type: string;
  owners: string[];
  threshold?: number;
  spendingLimits?: {
    dailyXlm?: string;
    perTxXlm?: string;
  };
  allowlistedContracts?: string[];
  timelocks?: {
    adminActionDelaySeconds?: number;
  };
  /**
   * On-chain safety rules for the `spending_limit` template (#399). Every
   * amount is in the token's BASE UNITS (stroops for XLM) — there is no price
   * oracle on Soroban, so rules are never fiat-denominated. Both tables are
   * bounded by the contract (8 entries each).
   */
  safetyRules?: {
    /** Per-token ceiling on any single transfer. */
    maxSingleTransfer?: Array<{ token: string; amountBaseUnits: string }>;
    /** When set, only transfers of these token contracts are authorized. */
    allowedTokens?: string[];
  };
  /**
   * Per-token budget for the `token_spending_limit` template (#394): the
   * cumulative allowance of ONE token contract over a fixed window, in that
   * token's base units.
   */
  tokenBudget?: {
    token: string;
    amountBaseUnits: string;
    windowSeconds?: number;
  };
  /**
   * Provenance mode for the `verified_only` template (#398). `strict` = any
   * live attestation; `trusted_publishers` = only attestations attributed to
   * one of the listed publishers (e.g. "github.com/vellar-wallet"). Verified
   * means reproducible, attributable source provenance — not audited or safe.
   */
  provenance?: {
    mode: "strict" | "trusted_publishers";
    trustedPublishers?: string[];
  };
}

// --- Contract Verification Module (idea.md §6.3) ---

// "dead_letter": a job reclaimed and re-run VERIFY_MAX_ATTEMPTS times without
// reaching a terminal state (security-audit.md M7) — parked so a poisoned job
// can't loop forever.
export type VerificationStatus =
  "unverified" | "submitted" | "building" | "verified" | "failed" | "dead_letter";

export interface VerificationRecord {
  id: string;
  contractId: string;
  sourceType: "repo" | "upload";
  repoUrl?: string;
  commitHash?: string;
  toolchainVersion: string;
  buildFlags?: string[];
  outputHash?: string;
  deployedHash?: string;
  /** How a verified record matched: "exact" (byte-for-byte) or
   * "toolchain-metadata" (identical except contractmetav0 rsver/rssdkver/cliver;
   * third-party contracts only, issue #419). */
  matchMode?: "exact" | "toolchain-metadata";
  status: VerificationStatus;
  createdAt: string;
  updatedAt: string;
}

// --- Account Lifecycle / Cleanup Module (idea.md §6.4) ---

export type CleanupBlockerType = "trustline" | "offer" | "data" | "balance";

export interface CleanupPlan {
  accountId: string;
  destination: string;
  blockers: Array<{
    type: CleanupBlockerType;
    description: string;
    actionRequired: string;
  }>;
  estimatedTransactions: number;
  mergeReady: boolean;
}
