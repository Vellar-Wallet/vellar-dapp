// @vela/types — shared domain types.
// Sourced from idea.md §6 (core interfaces). technical-doc.md governs scope.
// Keep these in sync with the docs; flag any divergence in docs/decisions.md.

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
}

// --- Contract Verification Module (idea.md §6.3) ---

export type VerificationStatus = "unverified" | "submitted" | "building" | "verified" | "failed";

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
