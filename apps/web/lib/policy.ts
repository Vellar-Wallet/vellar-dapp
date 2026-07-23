"use client";

import type { PolicyDefinition } from "@vela/types";
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
} from "@vela/wallet-sdk";
import { walletConfig } from "./config";

// Policy builder data layer (technical-doc.md §5.4, §7.5; idea.md §6.2, §11).
// The types + client now live in @vela/wallet-sdk so the SDK is the single
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
