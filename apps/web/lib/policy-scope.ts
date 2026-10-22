import type { PolicyDefinition } from "@vellar/types";

// Scope-overlap detection for the policy builder (#570). Attaching a second
// policy signer alongside an existing one can produce confusing or
// contradictory enforcement (e.g. two spending-limit policies both capping the
// same spend). This module answers "do these two policies constrain the same
// enforcement domain?" as a pure function so the review step can warn BEFORE
// the passkey approval — without blocking the deploy.

/** The enforcement domains a policy constrains. Two policies conflict when
 * their domain sets intersect. */
export function policyDomains(def: PolicyDefinition): string[] {
  switch (def.type) {
    case "spending_limit": {
      // Account-level spend caps; safety rules may further scope tokens.
      const domains = new Set<string>(["spend"]);
      for (const rule of def.safetyRules?.maxSingleTransfer ?? []) {
        domains.add(`spend:${rule.token}`);
      }
      for (const token of def.safetyRules?.allowedTokens ?? []) {
        domains.add(`contracts:${token}`);
      }
      return [...domains];
    }
    case "token_spending_limit":
      return ["spend", `spend:${def.tokenBudget?.token ?? "*"}`];
    case "verified_only":
      return ["provenance"];
    case "contract_allowlist":
      return (def.allowlistedContracts ?? []).map((c) => `contracts:${c}`);
    case "single_owner":
    case "multisig_threshold":
      return ["auth"];
    default:
      return [def.type];
  }
}

export interface ScopeConflict {
  /** Label for the already-attached policy that conflicts (e.g. its contract id). */
  label: string;
  /** The shared enforcement domain(s). */
  domains: string[];
}

/** Domains shared by two policies; empty = no overlap. */
export function sharedDomains(a: PolicyDefinition, b: PolicyDefinition): string[] {
  const left = new Set(policyDomains(a));
  return policyDomains(b).filter((d) => left.has(d));
}

/**
 * Find attached policies whose scope overlaps `incoming`.
 *
 * `attached` is the set of policy definitions already on the account (see
 * lib/policy-deployments.ts for how they are known). Two policies that do not
 * share any enforcement domain produce no conflict.
 */
export function findScopeConflicts(
  incoming: PolicyDefinition,
  attached: Array<{ label: string; definition: PolicyDefinition }>,
): ScopeConflict[] {
  const conflicts: ScopeConflict[] = [];
  for (const entry of attached) {
    const domains = sharedDomains(incoming, entry.definition);
    if (domains.length > 0) conflicts.push({ label: entry.label, domains });
  }
  return conflicts;
}
