"use client";

import type { PolicyDefinition } from "@vela/types";
import { walletConfig } from "./config";

// Policy builder data layer (technical-doc.md §5.4, §7.5; idea.md §6.2, §11).
// UI-free so the builder components stay presentational.

export interface SpendingConstructor {
  dailyLimitStroops: string;
  windowSeconds: number;
}

export type Enforcement =
  | { kind: "policy-contract"; wasmHash: string; constructorArgs?: SpendingConstructor }
  | { kind: "signer-limits" }
  | { kind: "none" }
  | { kind: "custom-contract-pending" };

export interface PolicyTemplateInfo {
  type: string;
  title: string;
  description: string;
  enforcement: Enforcement;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface GeneratedPolicy {
  id: string;
  createdAt: string;
  status: "generated" | "instance_deployed" | "deployed";
  definition: PolicyDefinition;
  policyHash: string;
  manifest: { template: string; enforcement: Enforcement; network: "testnet" | "mainnet" };
  instance?: { contractId: string; txHash: string; deployedAt: string };
  deployment?: { contractId?: string; txHash: string; deployedAt: string };
}

export interface SimulateResult {
  ok: boolean;
  minResourceFee?: string;
  error?: string;
}

export class PolicyApiError extends Error {
  readonly status: number;
  readonly errors?: string[];

  constructor(message: string, status: number, errors?: string[]) {
    super(message);
    this.name = "PolicyApiError";
    this.status = status;
    this.errors = errors;
  }
}

function base() {
  return walletConfig().apiUrl.replace(/\/+$/, "");
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base()}/policies${path}`, {
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    errors?: string[];
    message?: string;
  } & T;
  if (!res.ok) {
    throw new PolicyApiError(
      payload.message ?? payload.error ?? `Request failed (${res.status})`,
      res.status,
      payload.errors,
    );
  }
  return payload;
}

export function listTemplates(): Promise<PolicyTemplateInfo[]> {
  return req<PolicyTemplateInfo[]>("/templates");
}

export function validatePolicy(definition: PolicyDefinition): Promise<ValidationResult> {
  return req<ValidationResult>("/validate", {
    method: "POST",
    body: JSON.stringify(definition),
  });
}

export async function generatePolicy(definition: PolicyDefinition): Promise<GeneratedPolicy> {
  const { policy } = await req<{ policy: GeneratedPolicy }>("/generate", {
    method: "POST",
    body: JSON.stringify({ definition, network: walletConfig().network }),
  });
  return policy;
}

/** Dry-run the on-chain instance deploy for this wallet (no submit). */
export function simulatePolicyDeploy(policyId: string, wallet: string): Promise<SimulateResult> {
  return req<SimulateResult>(`/${policyId}/simulate`, {
    method: "POST",
    body: JSON.stringify({ wallet }),
  });
}

/** Deploy the per-user policy contract instance (server-side, sponsor-funded),
 * bound to the wallet. Returns the deployed contract id to attach next. */
export async function deployPolicyInstance(
  policyId: string,
  wallet: string,
): Promise<{ policy: GeneratedPolicy; contractId: string }> {
  return req<{ policy: GeneratedPolicy; contractId: string }>(`/${policyId}/deploy-instance`, {
    method: "POST",
    body: JSON.stringify({ wallet }),
  });
}

export async function recordDeployment(
  policyId: string,
  txHash: string,
  contractId?: string,
): Promise<GeneratedPolicy> {
  const { policy } = await req<{ policy: GeneratedPolicy }>("/deploy", {
    method: "POST",
    body: JSON.stringify({ policyId, txHash, contractId }),
  });
  return policy;
}

/** Minimal wallet surface the deploy orchestrator needs (a test seam so the
 * flow can be exercised without passkey-kit or a network). */
export interface PolicyAttachRuntime {
  resume(keyId: string): Promise<void>;
  attachPolicy(policyContractId: string): Promise<{ hash: string }>;
}

export interface DeployPolicyResult {
  policy: GeneratedPolicy;
  contractId: string;
  attachTxHash: string;
}

/**
 * Full policy deploy (Phase 5, technical-doc.md §7.5):
 *   1. deploy the contract instance bound to the wallet (server-side),
 *   2. passkey-sign kit.addPolicy to attach it (runs the contract's install),
 *   3. record the completed deployment.
 * The passkey prompt happens only at step 2 — no silent signing.
 */
export async function deployPolicy(
  policyId: string,
  session: { accountId: string; keyId?: string },
  runtime: PolicyAttachRuntime,
): Promise<DeployPolicyResult> {
  const { contractId } = await deployPolicyInstance(policyId, session.accountId);
  if (session.keyId) await runtime.resume(session.keyId);
  const { hash } = await runtime.attachPolicy(contractId);
  const policy = await recordDeployment(policyId, hash, contractId);
  return { policy, contractId, attachTxHash: hash };
}

/** Human summary of how a template is enforced on-chain (design.md trust copy). */
export function enforcementLabel(e: Enforcement): string {
  switch (e.kind) {
    case "policy-contract":
      return "Enforced on-chain by a dedicated policy contract deployed for your account (a cumulative rolling-window spending allowance).";
    case "signer-limits":
      return "Enforced by the smart wallet's native signer limits.";
    case "none":
      return "Default single-owner behaviour — no extra on-chain enforcement.";
    case "custom-contract-pending":
      return "Requires a custom policy contract (coming in a later phase).";
  }
}

/** Format stroops as an XLM string for display (e.g. "1000000000" → "100"). */
export function stroopsToXlm(stroops: string): string {
  const n = BigInt(stroops);
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
