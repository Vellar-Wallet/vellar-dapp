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

export type PolicySignerLifecycleErrorCode =
  "POLICY_DETACH_IN_FLIGHT" | "POLICY_DETACHED_DURING_SIGN" | "POLICY_ALREADY_DETACHED";

export class PolicySignerLifecycleError extends Error {
  readonly code: PolicySignerLifecycleErrorCode;
  readonly policyContractId: string;

  constructor(code: PolicySignerLifecycleErrorCode, policyContractId: string, message: string) {
    super(message);
    this.name = "PolicySignerLifecycleError";
    this.code = code;
    this.policyContractId = policyContractId;
  }
}

/** The policy attach/detach actions, wired to a kit + backend. Extracted from
 * connector-factory so the standalone-signer + recovery-key invariants are
 * tested at the WIRING layer (RA-6), not just at policyAttachArgs. */
export function createPolicySignerActions(deps: PolicySignerDeps) {
  const { kit, backend, network, SignerKey, SignerStore } = deps;
  const pendingDetaches = new Set<string>();
  const detachedPolicies = new Set<string>();
  const detachEpochs = new Map<string, number>();

  function normalizePolicyId(policyContractId: string): string {
    return policyContractId.trim();
  }

  function getDetachEpoch(id: string): number {
    return detachEpochs.get(id) ?? 0;
  }

  function assertCanStartOperation(policyContractId?: string, allowDetached = false): string {
    const id = policyContractId ? normalizePolicyId(policyContractId) : "";
    if (id && pendingDetaches.has(id)) {
      throw new PolicySignerLifecycleError(
        "POLICY_DETACH_IN_FLIGHT",
        id,
        `Cannot sign or modify policy "${id}" while a detach transaction is pending confirmation.`,
      );
    }
    if (!id && pendingDetaches.size > 0) {
      const activeId = Array.from(pendingDetaches)[0]!;
      throw new PolicySignerLifecycleError(
        "POLICY_DETACH_IN_FLIGHT",
        activeId,
        `Cannot sign transaction while policy "${activeId}" detach is pending confirmation.`,
      );
    }
    if (!allowDetached && id && detachedPolicies.has(id)) {
      throw new PolicySignerLifecycleError(
        "POLICY_ALREADY_DETACHED",
        id,
        `Cannot sign with policy "${id}" because it has already been detached.`,
      );
    }
    return id;
  }

  return {
    isDetachPending(policyContractId?: string): boolean {
      if (policyContractId) {
        return pendingDetaches.has(normalizePolicyId(policyContractId));
      }
      return pendingDetaches.size > 0;
    },

    isPolicyDetached(policyContractId: string): boolean {
      return detachedPolicies.has(normalizePolicyId(policyContractId));
    },

    async attachPolicy(policyContractId: string): Promise<{ hash: string }> {
      const id = assertCanStartOperation(policyContractId, true);
      const startEpoch = getDetachEpoch(id);
      // Standalone policy signer (SignerLimits = None) — policyAttachArgs pins
      // the shape; passing limits here would make it a required co-signer and
      // risk an unremovable rejecting policy (V3).
      const args = policyAttachArgs(id);
      const store = args.store === "Persistent" ? SignerStore.Persistent : SignerStore.Temporary;
      const tx = await kit.addPolicy(args.policyContractId, args.limits, store, args.expiration);
      if (pendingDetaches.has(id)) {
        throw new PolicySignerLifecycleError(
          "POLICY_DETACH_IN_FLIGHT",
          id,
          `Policy "${id}" detach started while attach was being prepared.`,
        );
      }
      const signed = await kit.sign(tx);
      if (pendingDetaches.has(id) || getDetachEpoch(id) !== startEpoch) {
        throw new PolicySignerLifecycleError(
          "POLICY_DETACHED_DURING_SIGN",
          id,
          `Policy "${id}" was detached while attach signature was in progress.`,
        );
      }
      const result = await backend.submitTransaction({ signedXdr: toXdr(signed, tx), network });
      detachedPolicies.delete(id);
      return result;
    },

    async detachPolicy(policyContractId: string): Promise<{ hash: string }> {
      const id = normalizePolicyId(policyContractId);
      if (pendingDetaches.has(id)) {
        throw new PolicySignerLifecycleError(
          "POLICY_DETACH_IN_FLIGHT",
          id,
          `Detach transaction for policy "${id}" is already pending confirmation.`,
        );
      }
      pendingDetaches.add(id);
      try {
        // Recovery path (V3 / FIX 5): remove the policy signer WITHOUT the policy's
        // consent. Must target SignerKey.Policy so the wallet's
        // is_sole_self_removal exception applies.
        const tx = await kit.remove(SignerKey.Policy(id));
        const signed = await kit.sign(tx);
        const result = await backend.submitTransaction({ signedXdr: toXdr(signed, tx), network });
        detachedPolicies.add(id);
        detachEpochs.set(id, getDetachEpoch(id) + 1);
        return result;
      } finally {
        pendingDetaches.delete(id);
      }
    },

    async signWithPolicy(policyContractId: string, tx: unknown): Promise<{ hash: string }> {
      const id = assertCanStartOperation(policyContractId);
      const startEpoch = getDetachEpoch(id);
      const signed = await kit.sign(tx);
      if (pendingDetaches.has(id)) {
        throw new PolicySignerLifecycleError(
          "POLICY_DETACH_IN_FLIGHT",
          id,
          `Policy "${id}" detach is in flight; aborting transaction submission to prevent on-chain auth failure.`,
        );
      }
      if (getDetachEpoch(id) !== startEpoch || detachedPolicies.has(id)) {
        throw new PolicySignerLifecycleError(
          "POLICY_DETACHED_DURING_SIGN",
          id,
          `Policy "${id}" detach completed while signing was in progress; aborting submission.`,
        );
      }
      return backend.submitTransaction({ signedXdr: toXdr(signed, tx), network });
    },
  };
}
