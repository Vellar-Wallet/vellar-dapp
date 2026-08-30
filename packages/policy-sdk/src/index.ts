import type { PolicyDefinition } from "@vellar/types";

// --- Known policy template types ---

export type PolicyTemplateType =
  | "single_owner"
  | "multisig_threshold"
  | "spending_limit"
  | "contract_allowlist"
  | "timelock"
  | "per_tx_cap"
  | "recipient_allowlist"
  | "never_sent_before";

// --- Enforcement descriptors ---

export type Enforcement =
  | { kind: "policy-contract"; wasmHash: string; constructorArgs?: SpendingConstructor }
  | { kind: "signer-limits" }
  | { kind: "none" }
  | { kind: "custom-contract-pending" };

export interface SpendingConstructor {
  dailyLimitStroops: string;
  windowSeconds: number;
}

// --- Template info returned by GET /policies/templates ---

export interface PolicyTemplateInfo {
  type: PolicyTemplateType;
  title: string;
  description: string;
  enforcement: Enforcement;
}

// --- Generation / validation results ---

export interface GeneratedPolicy {
  id: string;
  createdAt: string;
  status: "generated" | "instance_deployed" | "deployed";
  definition: PolicyDefinition;
  policyHash: string;
  manifest: {
    template: PolicyTemplateType;
    enforcement: Enforcement;
    network: "testnet" | "mainnet";
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface SimulateResult {
  ok: boolean;
  minResourceFee?: string;
  error?: string;
}

export interface DeployPolicyResult {
  policy: GeneratedPolicy;
  contractId: string;
  attachTxHash: string;
}

// --- Runtime seam for passkey attach (web app provides the implementation) ---

export interface PolicyAttachRuntime {
  resume?: (keyId: string) => Promise<void>;
  attachPolicy: (contractId: string) => Promise<{ hash: string }>;
}

// --- Utility functions ---

/** Stroops per XLM (7 decimals). */
const STROOPS_PER_XLM = 10_000_000n;

/** Convert a stroops string to an XLM decimal string. */
export function stroopsToXlm(stroops: string): string {
  const big = BigInt(stroops);
  const whole = big / STROOPS_PER_XLM;
  const frac = big % STROOPS_PER_XLM;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(7, "0").replace(/0+$/, "")}`;
}

/** Human-readable label for an enforcement descriptor. */
export function enforcementLabel(enforcement: Enforcement): string {
  switch (enforcement.kind) {
    case "policy-contract":
      return "Enforced by an on-chain policy contract";
    case "signer-limits":
      return "Enforced by the smart wallet's native signer limits";
    case "none":
      return "No additional enforcement";
    case "custom-contract-pending":
      return "Custom on-chain enforcement (pending contract deployment)";
  }
}

// --- Honest enforcement descriptions per template type ---

export const ENFORCEMENT_DESCRIPTIONS: Record<PolicyTemplateType, string> = {
  single_owner: "No on-chain policy enforcement. The sole key controls the account.",
  multisig_threshold:
    "Enforced by the smart wallet's native SignerLimits mechanism. The threshold is checked on-chain for every sensitive action.",
  spending_limit:
    "Enforced by a deployed on-chain policy contract. The contract tracks cumulative transfers within a rolling window and rejects transactions that would exceed the cap. Coverage is limited to known transfer patterns (SEP-41 transfer operations).",
  contract_allowlist:
    "Enforced by the smart wallet's native SignerLimits mechanism. Only interactions with the listed contracts are permitted.",
  timelock:
    "Custom on-chain enforcement pending contract deployment. The delay is not yet enforced on-chain.",
  per_tx_cap:
    "Custom on-chain enforcement pending contract deployment. The per-transaction cap is not yet enforced on-chain. Coverage will be limited to known transfer patterns once the contract is deployed.",
  recipient_allowlist:
    "Enforced by the smart wallet's native SignerLimits mechanism. Transfers are restricted to the allowed recipient addresses.",
  never_sent_before:
    "Enforced by the smart wallet's native SignerLimits mechanism. Transfers to recipients that have previously received funds are blocked.",
};

// --- Escalation (A7: second passkey confirmation) ---

export interface EscalationReason {
  templateType: PolicyTemplateType;
  message: string;
}

export interface EscalationCheck {
  required: boolean;
  reasons: EscalationReason[];
}

/**
 * Check whether a transaction triggers any policy escalation that requires a
 * second passkey confirmation. This is a client-side heuristic — the on-chain
 * contracts enforce the actual rules, but the wallet should always prompt the
 * user explicitly when a policy may be relevant.
 *
 * @param policies - the account's deployed policy definitions
 * @param txDetails - details of the transaction being signed
 * @returns whether escalation is required and why
 */
export function checkEscalation(
  policies: PolicyDefinition[],
  txDetails: { amountXlm?: string; recipient?: string; previouslySentRecipients?: string[] },
): EscalationCheck {
  const reasons: EscalationReason[] = [];

  for (const policy of policies) {
    if (policy.type === "per_tx_cap" && policy.perTxCapXlm && txDetails.amountXlm) {
      if (Number(txDetails.amountXlm) > Number(policy.perTxCapXlm)) {
        reasons.push({
          templateType: "per_tx_cap",
          message: `This transaction (${txDetails.amountXlm} XLM) exceeds your per-transaction cap of ${policy.perTxCapXlm} XLM. An additional confirmation is required.`,
        });
      }
    }

    if (policy.type === "recipient_allowlist" && policy.allowedRecipients && txDetails.recipient) {
      if (!policy.allowedRecipients.includes(txDetails.recipient)) {
        const denied =
          policy.deniedRecipients && policy.deniedRecipients.includes(txDetails.recipient);
        reasons.push({
          templateType: "recipient_allowlist",
          message: denied
            ? `This recipient is on your deny list. An additional confirmation is required.`
            : `This recipient is not on your allow list. An additional confirmation is required.`,
        });
      }
    }

    if (
      policy.type === "never_sent_before" &&
      txDetails.recipient &&
      txDetails.previouslySentRecipients?.includes(txDetails.recipient)
    ) {
      reasons.push({
        templateType: "never_sent_before",
        message: `This recipient has received funds from your account before. An additional confirmation is required.`,
      });
    }
  }

  return { required: reasons.length > 0, reasons };
}
