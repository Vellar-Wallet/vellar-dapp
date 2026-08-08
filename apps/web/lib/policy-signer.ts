// Policy signer attach/detach invariants (security-audit.md V3 / FIX 5).
//
// V3 proved a rejecting `verified_only` policy is NOT a permanent fund-freeze:
// the wallet's admin passkey can detach it WITHOUT the policy's consent. But
// that recovery ONLY holds because the policy is attached as a STANDALONE
// signer (SignerLimits = None), which triggers the smart wallet's
// `is_sole_self_removal` exception in __check_auth. If a future change attached
// the policy as a REQUIRED co-signer inside another key's SignerLimits, a
// reject-everything policy could block its own removal and freeze the wallet.
//
// This module pins the attach shape so that invariant is explicit and tested,
// and centralizes the detach key so recovery has a single source of truth.

/** The passkey-kit SignerStore variant used for policy signers. Persistent so
 * the rule is durable on the account. Kept as a string tag the test asserts
 * without importing the browser-only passkey-kit enum. */
export type SignerStoreTag = "Persistent" | "Temporary";

export interface PolicyAttachArgs {
  policyContractId: string;
  /** MUST be undefined: a standalone policy signer (no SignerLimits), so the
   * wallet's self-removal exception lets the admin passkey detach it even if it
   * rejects everything (V3). A non-undefined value here would make the policy a
   * required co-signer and risk an unremovable rejecting policy. */
  limits: undefined;
  store: SignerStoreTag;
  /** No expiration: a policy signer is revoked by removal, not by TTL. */
  expiration: undefined;
}

/** Build the args for kit.addPolicy so the standalone-signer invariant is a
 * single, asserted value rather than four inline literals at the call site. */
export function policyAttachArgs(policyContractId: string): PolicyAttachArgs {
  return {
    policyContractId,
    limits: undefined,
    store: "Persistent",
    expiration: undefined,
  };
}
