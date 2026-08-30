/**
 * Type definitions for cleanup plan generation
 */

export interface Step {
  order: number;
  type: string;
  description: string;
}

export interface CleanupPlan {
  accountId: string;
  steps: Step[];
}

/**
 * Step types for cleanup actions
 */
export const STEP_TYPES = {
  CLOSE_TRUSTLINE: "CLOSE_TRUSTLINE",
  CANCEL_OFFER: "CANCEL_OFFER",
  RELEASE_ESCROW: "RELEASE_ESCROW",
  DISABLE_CLAWBACK: "DISABLE_CLAWBACK",
  VERIFY_SEQUENCE: "VERIFY_SEQUENCE",
  FINALIZE: "FINALIZE",
} as const;

export type StepType = (typeof STEP_TYPES)[keyof typeof STEP_TYPES];
