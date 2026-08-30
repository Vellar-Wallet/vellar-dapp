/**
 * Deployment orchestration module for policy-service.
 *
 * Handles all deployment-related concerns:
 * - Instance provisioning (deployer calls)
 * - L1 attach verification
 * - Budget consumption
 * - Record state transitions
 * - Deployment-specific error handling
 *
 * Takes dependencies as parameters (deployer, budget, verifyAttach, etc.)
 * and returns updated records or simulation results.
 * No side effects beyond record updates passed to caller.
 */

import { DEPLOY_FEE, PolicyDeployError, type PolicyDeployer } from "./deploy";
import {
  AttachMismatchError,
  AttachUnconfirmedError,
  verifyAttachTx,
  type TxLookup,
} from "./verify-attach";
import { recordOutcome, domainMetrics, type SpendBudget, type BudgetNetwork } from "@vellar/service-kit";
import type { PolicyRecord, PolicyRepository } from "./server";
import type { Network } from "@vellar/types";

export { DEPLOY_FEE } from "./deploy";
export type { PolicyDeployer, SimulateResult } from "./deploy";

/**
 * Dependencies for deployment operations.
 * All are optional (some deployment features may be disabled).
 */
export interface DeploymentDeps {
  /** Policy repository for persisting state updates */
  policies: PolicyRepository;
  /** Instance deployer (sponsor-funded provisioning). Undefined = deploy unavailable (503). */
  deployer?: PolicyDeployer;
  /** RPC transaction lookup for L1 attach verification. Undefined = verification disabled. */
  verifyAttach?: TxLookup;
  /** Rolling-window spend budget for "deploy" line. Undefined = budget check disabled. */
  budget?: SpendBudget;
  /** Network label for budget accounting (from server config, never request body). */
  budgetNetwork?: BudgetNetwork;
  /** Network label for attach verification (from server config, never request body). */
  network?: BudgetNetwork;
  /** Network passphrase for XDR decoding. Defaults to testnet. */
  networkPassphrase?: string;
  /** Clock for timestamps. Defaults to Date.now(). */
  now?: () => Date;
}

/**
 * Simulates the deployment of a policy instance without submitting it.
 * Calls deployer.simulateInstance and returns the result.
 * No state changes.
 *
 * Throws if deployer is not configured (caller should handle and return 503).
 */
export async function simulatePolicyDeploy(
  deps: DeploymentDeps,
  record: PolicyRecord,
  wallet: string,
): Promise<{ ok: boolean; minResourceFee?: string; error?: string }> {
  const enforcement = record.manifest.enforcement;
  if (enforcement.kind !== "policy-contract" || !enforcement.constructorArgs) {
    throw new Error("Policy is not contract-enforced");
  }

  const result = await deps.deployer!.simulateInstance({
    wallet,
    constructorArgs: enforcement.constructorArgs,
  });
  return result;
}

/**
 * Deploys a policy instance bound to the given wallet.
 *
 * Steps:
 * 1. Consume sponsor budget (if configured; fail closed)
 * 2. Call deployer.deployInstance() to provision on-chain
 * 3. Update record with instance info (contractId, wallet, txHash, deployedAt)
 * 4. Set record.status = "instance_deployed"
 * 5. Persist updated record to repository
 * 6. Record metrics (success/failure)
 * 7. Return updated record and contractId
 *
 * Throws PolicyDeployError if the on-chain deploy fails.
 * Returns normally on success.
 *
 * Caller must handle and map to HTTP responses:
 * - PolicyDeployError → 502 with error.code
 * - Other errors (budget accounting failure) → let propagate to caller for 503 mapping
 */
export async function deployPolicyInstance(
  deps: DeploymentDeps,
  record: PolicyRecord,
  wallet: string,
): Promise<{ record: PolicyRecord; contractId: string }> {
  const enforcement = record.manifest.enforcement;
  if (enforcement.kind !== "policy-contract" || !enforcement.constructorArgs) {
    throw new Error("Policy is not contract-enforced");
  }

  // Consume sponsor-funded "deploy" budget line before spending (FIX 3).
  // Fails CLOSED: a refusal or accounting error blocks the deploy.
  // Network label from server config, never the request body (V5).
  if (deps.budget && deps.budgetNetwork) {
    let allowed: boolean;
    try {
      const r = await deps.budget.tryConsume({
        line: "deploy",
        network: deps.budgetNetwork,
        stroops: BigInt(DEPLOY_FEE),
      });
      allowed = r.ok;
    } catch (err) {
      // Budget accounting failed; refuse. Fail closed.
      allowed = false;
    }
    if (!allowed) {
      recordOutcome(domainMetrics.policyDeployed, "policy-service", "failure");
      throw new Error("deploy_budget_exceeded");
    }
  }

  // Deploy the instance on-chain.
  let result: { contractId: string; txHash: string };
  try {
    result = await deps.deployer!.deployInstance({
      wallet,
      constructorArgs: enforcement.constructorArgs,
    });
  } catch (err) {
    if (err instanceof PolicyDeployError) {
      recordOutcome(domainMetrics.policyDeployed, "policy-service", "failure");
      throw err; // Propagate for caller to handle
    }
    throw err;
  }

  // Update record with deployed instance info.
  const now = deps.now ?? (() => new Date());
  record.status = "instance_deployed";
  record.instance = {
    ...result,
    wallet,
    deployedAt: now().toISOString(),
  };
  await deps.policies.update(record);

  recordOutcome(domainMetrics.policyDeployed, "policy-service", "success");
  return { record, contractId: result.contractId };
}

/**
 * Verifies an attach transaction on-chain and records the deployment.
 *
 * Steps (if verifyAttach is configured):
 * 1. Call verifyAttachTx() to confirm the attach on-chain
 * 2. If verification fails, throw AttachUnconfirmedError (503-worthy) or AttachMismatchError (422-worthy)
 *
 * Then (always):
 * 3. Update record.deployment with contractId, txHash, deployedAt
 * 4. Set record.status = "deployed"
 * 5. Persist updated record
 * 6. Return updated record
 *
 * Throws:
 * - AttachUnconfirmedError: RPC unreachable or tx not found → caller maps to 503
 * - AttachMismatchError: Tx confirmed but doesn't match → caller maps to 422
 *
 * Returns updated record on success.
 */
export async function verifyAndRecordAttach(
  deps: DeploymentDeps,
  record: PolicyRecord,
  txHash: string,
  contractId?: string,
): Promise<PolicyRecord> {
  // Full attach verification (L1): the client-supplied txHash must actually be
  // an add_signer on THIS wallet binding THIS policy contract on-chain.
  if (deps.verifyAttach) {
    if (!record.instance) {
      throw new Error("no_instance");
    }
    const network = deps.network ?? "testnet";
    const networkPassphrase = deps.networkPassphrase ?? "Test SDF Network ; September 2015";

    try {
      await verifyAttachTx(
        deps.verifyAttach,
        {
          txHash,
          network: network as unknown as Network,
          wallet: record.instance.wallet,
          policyContractId: record.instance.contractId,
        },
        networkPassphrase,
      );
    } catch (err) {
      // Re-throw as-is; caller will handle and map to HTTP response.
      // AttachUnconfirmedError → 503
      // AttachMismatchError → 422
      throw err;
    }
  }

  // Record the completed attach.
  const now = deps.now ?? (() => new Date());
  record.status = "deployed";
  record.deployment = {
    contractId,
    txHash,
    deployedAt: now().toISOString(),
  };
  await deps.policies.update(record);

  return record;
}
