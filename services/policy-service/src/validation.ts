/**
 * Validation module for policy-service.
 *
 * Handles all policy definition and record state validation:
 * - Policy definition schemas (delegated to templates.validateDefinition)
 * - Request body schemas (Zod parsing)
 * - Record state validation (enforceability, instance existence, status checks)
 *
 * Pure functions, no side effects, no deployment orchestration.
 */

import { z } from "zod";
import { validateDefinition as validatePolicyDefinition } from "./templates";
import type { PolicyRecord } from "./server";

// Re-export for consumers
export { validateDefinition as validatePolicyDefinition } from "./templates";

/**
 * Validation result for a policy definition.
 * Re-exported from templates for convenience.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Request body schemas for policy endpoints.
 */

export const generateBodySchema = z.object({
  definition: z.unknown(),
  network: z.enum(["testnet", "mainnet"]),
});

export const deployBodySchema = z.object({
  policyId: z.string().min(1),
  /** Hash of the on-chain attach (kit.addPolicy) transaction, passkey-signed client-side. */
  txHash: z.string().min(1),
  contractId: z.string().optional(),
});

const walletAddress = z.string().regex(/^C[A-Z2-7]{55}$/, "must be a smart-account address (C…)");

export const deployInstanceBodySchema = z.object({
  /** The user's smart-account the policy instance is bound to. */
  wallet: walletAddress,
});

/**
 * Validates that a policy record can be deployed as a contract instance.
 * This checks the enforcement type and the presence of constructor args.
 *
 * Returns { valid: true } if the policy is contract-enforced and has constructorArgs.
 * Returns { valid: false, error: "..." } otherwise.
 */
export function validatePolicyForDeployment(
  record: PolicyRecord,
): { valid: boolean; error?: string } {
  const enforcement = record.manifest.enforcement;
  if (enforcement.kind !== "policy-contract") {
    return {
      valid: false,
      error: "this policy is enforced without a deployed contract instance",
    };
  }
  if (!enforcement.constructorArgs) {
    return {
      valid: false,
      error: "policy contract enforcement is missing constructor args",
    };
  }
  return { valid: true };
}

/**
 * Validates that a policy record has a deployed instance.
 * Used before attach verification to ensure the instance exists.
 *
 * Returns { valid: true } if record.instance is set.
 * Returns { valid: false, error: "..." } otherwise.
 */
export function validatePolicyInstance(
  record: PolicyRecord,
): { valid: boolean; error?: string } {
  if (!record.instance) {
    return {
      valid: false,
      error: "No deployed policy instance to verify an attach against.",
    };
  }
  return { valid: true };
}

/**
 * Wrapper to call templates.validateDefinition with type safety.
 * Validates a policy definition against the supported templates.
 */
export function validateDefinition(definition: unknown): ValidationResult {
  return validatePolicyDefinition(definition);
}
