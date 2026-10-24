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

// --- Attach/detach WIRING (RA-6) --------------------------------------------
//
// The invariant above (standalone SignerLimits(None) → detachable) was pinned
// only at the pure helper; the code that actually calls kit.addPolicy/kit.remove
// lived inline in connector-factory and was untested — so a refactor inlining a
// SignerLimits map would ship green. The attach/detach flow is extracted here so
// the wiring is unit-tested with a fake kit: attach MUST pass limits===undefined,
// and detach MUST remove exactly SignerKey.Policy(id) (the key the wallet's
// is_sole_self_removal exception recognizes). The passkey-kit enums are injected
// (they touch browser APIs) so this module stays SSR/test-safe.

/** Minimal structural view of the passkey-kit surface the actions use. */
export interface PolicySignerKit {
  addPolicy(
    policyContractId: string,
    limits: undefined,
    store: unknown,
    expiration: undefined,
  ): Promise<unknown>;
  remove(signerKey: unknown): Promise<unknown>;
  sign(tx: unknown): Promise<unknown>;
}

export interface PolicySignerBackend {
  submitTransaction(req: { signedXdr: string; network: string }): Promise<{ hash: string }>;
}

export interface PolicySignerDeps {
  kit: PolicySignerKit;
  backend: PolicySignerBackend;
  network: string;
  /** passkey-kit SignerKey (SignerKey.Policy) — injected (browser-only). */
  SignerKey: { Policy(id: string): unknown };
  /** passkey-kit SignerStore enum — injected (browser-only). */
  SignerStore: { Persistent: unknown; Temporary: unknown };
}

function toXdr(signed: unknown, fallback: unknown): string {
  const value = signed ?? fallback;
  return typeof value === "string" ? value : (value as { toXDR(): string }).toXDR();
}

/** The policy attach/detach actions, wired to a kit + backend. Extracted from
 * connector-factory so the standalone-signer + recovery-key invariants are
 * tested at the WIRING layer (RA-6), not just at policyAttachArgs. */
export function createPolicySignerActions(deps: PolicySignerDeps) {
  const { kit, backend, network, SignerKey, SignerStore } = deps;
  /** Policies with an in-flight detach (submitted, not yet confirmed). */
  const pendingDetaches = new Set<string>();

  return {
    async attachPolicy(policyContractId: string): Promise<{ hash: string }> {
      // Standalone policy signer (SignerLimits = None) — policyAttachArgs pins
      // the shape; passing limits here would make it a required co-signer and
      // risk an unremovable rejecting policy (V3).
      const args = policyAttachArgs(policyContractId);
      const store = args.store === "Persistent" ? SignerStore.Persistent : SignerStore.Temporary;
      const tx = await kit.addPolicy(args.policyContractId, args.limits, store, args.expiration);
      const signed = await kit.sign(tx);
      return backend.submitTransaction({ signedXdr: toXdr(signed, tx), network });
    },

    async detachPolicy(policyContractId: string): Promise<{ hash: string }> {
      // Recovery path (V3 / FIX 5): remove the policy signer WITHOUT the policy's
      // consent. Must target SignerKey.Policy so the wallet's
      // is_sole_self_removal exception applies.
      pendingDetaches.add(policyContractId);
      try {
        const tx = await kit.remove(SignerKey.Policy(policyContractId));
        const signed = await kit.sign(tx);
        return await backend.submitTransaction({ signedXdr: toXdr(signed, tx), network });
      } finally {
        pendingDetaches.delete(policyContractId);
      }
    },

    /**
     * Sign `tx` under `policyContractId`'s evaluation.
     *
     * Deliberately REJECTED while that policy's detach is still pending
     * confirmation: the detach is the recovery path (V3 / FIX 5) and a
     * concurrent signature would race it. A request that already started is
     * not retroactively failed — the guard is checked at initiation. Once the
     * detach resolves (success or failure) the guard clears.
     */
    async requestSignature(policyContractId: string, tx: unknown): Promise<unknown> {
      if (pendingDetaches.has(policyContractId)) {
        throw new Error(
          "Policy is being detached — wait for the removal to confirm before requesting a signature.",
        );
      }
      return kit.sign(tx);
    },
  };
}
