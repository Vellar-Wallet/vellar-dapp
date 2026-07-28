/**
 * Type definitions for merge eligibility checking
 */

export interface Trustline {
  asset: string;
  balance: string;
}

export interface Offer {
  id: string;
  selling: string;
  buying: string;
}

export interface EscrowEntry {
  id: string;
  amount: string;
}

export interface Account {
  id: string;
  trustlines: Trustline[];
  offers: Offer[];
  escrow: EscrowEntry[];
  clawbackEnabled: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * Reason codes for ineligibility
 */
export const REASON_CODES = {
  OPEN_TRUSTLINES: "OPEN_TRUSTLINES",
  PENDING_OFFERS: "PENDING_OFFERS",
  ESCROW_ENTRIES: "ESCROW_ENTRIES",
  CLAWBACK_ENABLED: "CLAWBACK_ENABLED",
  SEQUENCE_MISMATCH: "SEQUENCE_MISMATCH",
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];
