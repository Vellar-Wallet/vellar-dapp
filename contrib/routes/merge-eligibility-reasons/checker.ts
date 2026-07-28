/**
 * Merge eligibility checker
 * Validates if an account is eligible for merging and returns reason codes if not
 */

import type { Account, EligibilityResult, ReasonCode } from "./types";
import { REASON_CODES } from "./types";

/**
 * Checks if an account is eligible for merging
 * @param account The account to check
 * @returns EligibilityResult with eligible status and reason codes if ineligible
 */
export function checkMergeEligibility(account: Account): EligibilityResult {
  const reasons: ReasonCode[] = [];

  // Check for open trustlines
  if (account.trustlines.length > 0) {
    reasons.push(REASON_CODES.OPEN_TRUSTLINES);
  }

  // Check for pending offers
  if (account.offers.length > 0) {
    reasons.push(REASON_CODES.PENDING_OFFERS);
  }

  // Check for escrow entries
  if (account.escrow.length > 0) {
    reasons.push(REASON_CODES.ESCROW_ENTRIES);
  }

  // Check if clawback is enabled
  if (account.clawbackEnabled) {
    reasons.push(REASON_CODES.CLAWBACK_ENABLED);
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}
