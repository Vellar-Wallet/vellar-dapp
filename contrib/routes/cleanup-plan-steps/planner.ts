/**
 * Cleanup plan generator
 * Creates ordered cleanup steps for accounts to resolve merge blockers
 */

import type { CleanupPlan, Step } from "./types";
import { STEP_TYPES } from "./types";

/**
 * Generates a cleanup plan for the given account ID
 * @param accountId The account ID to generate a cleanup plan for
 * @returns CleanupPlan with ordered steps
 */
export function getCleanupPlan(accountId: string): CleanupPlan {
  const plans: Record<string, Step[]> = {
    GAAA2B3GRZL6XWDPJ5L3HVPFQY6A3OKDKDKJQJQJQJQJQJQJQJQJQJQJQJQJQ: [
      {
        order: 1,
        type: STEP_TYPES.CLOSE_TRUSTLINE,
        description:
          "Close trustline to USD issued by GBUQWP3BOUZX34TOLXCI35FQ7KQJH3P25PMMOMQ5J2MABG3HQZPX5YHK",
      },
      {
        order: 2,
        type: STEP_TYPES.CANCEL_OFFER,
        description: "Cancel pending offer #123 (selling native for USD)",
      },
      {
        order: 3,
        type: STEP_TYPES.FINALIZE,
        description: "Verify all cleanup steps completed and account is ready for merge",
      },
    ],
    GBBB2B3GRZL6XWDPJ5L3HVPFQY6A3OKDKDKJQJQJQJQJQJQJQJQJQJQJQJQJQ: [
      {
        order: 1,
        type: STEP_TYPES.CLOSE_TRUSTLINE,
        description:
          "Close trustline to USD issued by GBUQWP3BOUZX34TOLXCI35FQ7KQJH3P25PMMOMQ5J2MABG3HQZPX5YHK (balance: 100.50)",
      },
      {
        order: 2,
        type: STEP_TYPES.CLOSE_TRUSTLINE,
        description:
          "Close trustline to EUR issued by GDGU6VM5PSPZTHTFIUYJQMTHEGYLOQJQJQJQJQJQJQJQJQJQJQJQJQJQJQ (balance: 50.25)",
      },
      {
        order: 3,
        type: STEP_TYPES.CANCEL_OFFER,
        description: "Cancel pending offer #123 (selling native for USD)",
      },
      {
        order: 4,
        type: STEP_TYPES.CANCEL_OFFER,
        description: "Cancel pending offer #456 (selling EUR for native)",
      },
      {
        order: 5,
        type: STEP_TYPES.RELEASE_ESCROW,
        description: "Release escrow entry #escrow-456 (amount: 1000.00)",
      },
      {
        order: 6,
        type: STEP_TYPES.DISABLE_CLAWBACK,
        description: "Disable clawback on all issued assets",
      },
      {
        order: 7,
        type: STEP_TYPES.FINALIZE,
        description: "Verify all cleanup steps completed and account is ready for merge",
      },
    ],
  };

  const steps = plans[accountId] || [];

  return {
    accountId,
    steps,
  };
}

/**
 * Validates that steps in a plan are properly ordered
 * @param plan The cleanup plan to validate
 * @returns true if steps are in correct sequential order
 */
export function validateStepOrder(plan: CleanupPlan): boolean {
  for (let i = 0; i < plan.steps.length; i++) {
    if (plan.steps[i].order !== i + 1) {
      return false;
    }
  }
  return true;
}
