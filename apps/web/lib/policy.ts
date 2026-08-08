"use client";

import type { PolicyDefinition } from "@vellar/types";
import {
  createPolicyClient,
  enforcementLabel,
  stroopsToXlm,
  PolicyApiError,
  type DeployPolicyResult,
  type Enforcement,
  type GeneratedPolicy,
  type PolicyAttachRuntime,
  type PolicyTemplateInfo,
  type SimulateResult,
  type SpendingConstructor,
  type ValidationResult,
} from "vellar-sdk";
import { walletConfig } from "./config";

// Policy builder data layer (technical-doc.md §5.4, §7.5; idea.md §6.2, §11).
// The types + client now live in vellar-sdk so the SDK is the single
// source and third-party integrators get the same API (DRY — this file used to
// duplicate all of it). Here we just bind the SDK client to the web app's
// walletConfig and keep the function names the /policies page already imports.

export type {
  DeployPolicyResult,
  Enforcement,
  GeneratedPolicy,
  PolicyAttachRuntime,
  PolicyTemplateInfo,
  SimulateResult,
  SpendingConstructor,
  ValidationResult,
};
export { enforcementLabel, stroopsToXlm, PolicyApiError };

function client() {
  const cfg = walletConfig();
  return createPolicyClient({ apiUrl: cfg.apiUrl, network: cfg.network });
}

export function listTemplates(): Promise<PolicyTemplateInfo[]> {
  return client().listTemplates();
}

export function validatePolicy(definition: PolicyDefinition): Promise<ValidationResult> {
  return client().validate(definition);
}

export function generatePolicy(definition: PolicyDefinition): Promise<GeneratedPolicy> {
  return client().generate(definition);
}

/** Dry-run the on-chain instance deploy for this wallet (no submit). */
export function simulatePolicyDeploy(policyId: string, wallet: string): Promise<SimulateResult> {
  return client().simulate(policyId, wallet);
}

/** Deploy the per-user policy contract instance (server-side, sponsor-funded). */
export function deployPolicyInstance(
  policyId: string,
  wallet: string,
): Promise<{ contractId: string }> {
  return client().deployInstance(policyId, wallet);
}

export function recordDeployment(
  policyId: string,
  txHash: string,
  contractId?: string,
): Promise<GeneratedPolicy> {
  return client().recordDeployment(policyId, txHash, contractId);
}

/**
 * Full policy deploy (Phase 5, technical-doc.md §7.5): deploy instance →
 * passkey-sign kit.addPolicy to attach → record. The passkey prompt happens
 * only at the attach step (no silent signing). The runtime is the web app's
 * connector-factory attach seam. Kept here so /policies keeps its import.
 */
export async function deployPolicy(
  policyId: string,
  session: { accountId: string; keyId?: string },
  runtime: PolicyAttachRuntime,
): Promise<DeployPolicyResult> {
  const api = client();
  const { contractId } = await api.deployInstance(policyId, session.accountId);
  if (session.keyId && runtime.resume) await runtime.resume(session.keyId);
  const { hash } = await runtime.attachPolicy(contractId);
  const policy = await api.recordDeployment(policyId, hash, contractId);
  return { policy, contractId, attachTxHash: hash };
}

/** Runtime seam for detaching a policy — the connector-factory's detachPolicy
 * plus the optional reconnect. Narrow so tests inject a fake. */
export interface PolicyDetachRuntime {
  resume?: (keyId: string) => Promise<void>;
  detachPolicy: (policyContractId: string) => Promise<{ hash: string }>;
}

/**
 * Detach an attached policy from the wallet (security-audit.md V3 / FIX 5).
 * The admin passkey removes the standalone policy signer WITHOUT the policy's
 * consent — the recovery path for a wallet stuck behind a reject-everything
 * policy. Only the passkey prompt gates it (no silent signing). Returns the
 * removal tx hash.
 */
export async function detachPolicy(
  policyContractId: string,
  session: { keyId?: string },
  runtime: PolicyDetachRuntime,
): Promise<{ hash: string }> {
  if (session.keyId && runtime.resume) await runtime.resume(session.keyId);
  return runtime.detachPolicy(policyContractId);
}
