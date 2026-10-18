import { describe, expect, it, vi } from "vitest";
import {
  PolicySignerLifecycleError,
  createPolicySignerActions,
  policyAttachArgs,
} from "./policy-signer";

describe("policyAttachArgs — standalone-signer invariant (V3/FIX 5)", () => {
  it("attaches a policy with NO SignerLimits (limits === undefined)", () => {
    // This is the load-bearing assertion: a standalone signer triggers the
    // wallet's is_sole_self_removal exception, so the admin passkey can detach a
    // reject-everything policy. If someone changes attach to pass limits, this
    // fails LOUDLY rather than silently making a rejecting policy unremovable.
    const args = policyAttachArgs("CPOLICY");
    expect(args.limits).toBeUndefined();
  });

  it("uses a Persistent store and no expiration (revoked by removal, not TTL)", () => {
    const args = policyAttachArgs("CPOLICY");
    expect(args.store).toBe("Persistent");
    expect(args.expiration).toBeUndefined();
  });

  it("passes the policy contract id through unchanged", () => {
    expect(policyAttachArgs("CPOLICY").policyContractId).toBe("CPOLICY");
  });
});

// RA-6: the invariant was pinned ONLY at the pure helper. The WIRING — what the
// connector actually passes to kit.addPolicy / kit.remove — was untested, so a
// refactor that inlined a SignerLimits map (making the policy a required
// co-signer) would ship green. These tests drive the real attach/detach actions
// with a fake kit and assert what the kit is actually called with.
describe("createPolicySignerActions — attach/detach wiring (RA-6)", () => {
  function fakes() {
    const calls = {
      addPolicy: [] as unknown[][],
      remove: [] as unknown[],
      signed: 0,
      submitted: [] as { signedXdr: string; network: string }[],
    };
    const kit = {
      addPolicy: vi.fn((...args: unknown[]) => {
        calls.addPolicy.push(args);
        return Promise.resolve("attach-xdr");
      }),
      remove: vi.fn((signerKey: unknown) => {
        calls.remove.push(signerKey);
        return Promise.resolve("detach-xdr");
      }),
      sign: vi.fn((tx: string) => {
        calls.signed++;
        return Promise.resolve(`signed:${tx}`);
      }),
    };
    // Fake SignerKey.Policy so we can assert detach targets the policy key.
    const SignerKey = { Policy: (id: string) => ({ tag: "Policy", id }) };
    const SignerStore = { Persistent: "PERSISTENT", Temporary: "TEMPORARY" };
    const backend = {
      submitTransaction: vi.fn((req: { signedXdr: string; network: string }) => {
        calls.submitted.push(req);
        return Promise.resolve({ hash: "txhash" });
      }),
    };
    return { calls, kit, backend, SignerKey, SignerStore };
  }

  it("attachPolicy calls kit.addPolicy with limits === undefined (standalone SignerLimits(None))", async () => {
    const { calls, kit, backend, SignerKey, SignerStore } = fakes();
    const actions = createPolicySignerActions({
      kit: kit as never,
      backend: backend as never,
      network: "testnet",
      SignerKey: SignerKey as never,
      SignerStore: SignerStore as never,
    });

    const res = await actions.attachPolicy("CPOLICY");

    expect(calls.addPolicy).toHaveLength(1);
    const [policyId, limits, store, expiration] = calls.addPolicy[0]!;
    expect(policyId).toBe("CPOLICY");
    // THE load-bearing assertion at the wiring layer: NO SignerLimits map.
    expect(limits).toBeUndefined();
    expect(store).toBe(SignerStore.Persistent);
    expect(expiration).toBeUndefined();
    // It signs and submits on the configured network.
    expect(calls.signed).toBe(1);
    expect(calls.submitted[0]).toMatchObject({ network: "testnet" });
    expect(res.hash).toBe("txhash");
  });

  it("detachPolicy removes exactly SignerKey.Policy(contractId) — the consent-free recovery key", async () => {
    const { calls, kit, backend, SignerKey, SignerStore } = fakes();
    const actions = createPolicySignerActions({
      kit: kit as never,
      backend: backend as never,
      network: "testnet",
      SignerKey: SignerKey as never,
      SignerStore: SignerStore as never,
    });

    await actions.detachPolicy("CPOLICY");

    expect(calls.remove).toHaveLength(1);
    // Removal must target the Policy signer key (not some other key), or the
    // is_sole_self_removal recovery path doesn't apply.
    expect(calls.remove[0]).toEqual({ tag: "Policy", id: "CPOLICY" });
    expect(calls.signed).toBe(1);
    expect(calls.submitted[0]).toMatchObject({ network: "testnet" });
  });

  describe("mid-detach concurrency and lifecycle guards (#559)", () => {
    it("rejects a sign request issued while a detach transaction is still pending confirmation", async () => {
      const { calls, kit, backend, SignerKey, SignerStore } = fakes();
      let resolveDetachSubmit!: (value: { hash: string }) => void;
      backend.submitTransaction.mockImplementationOnce(
        (req: { signedXdr: string; network: string }) => {
          calls.submitted.push(req);
          return new Promise<{ hash: string }>((resolve) => {
            resolveDetachSubmit = resolve;
          });
        },
      );

      const actions = createPolicySignerActions({
        kit: kit as never,
        backend: backend as never,
        network: "testnet",
        SignerKey: SignerKey as never,
        SignerStore: SignerStore as never,
      });

      const detachPromise = actions.detachPolicy("CPOLICY");
      // Wait a microtask so detach reaches backend.submitTransaction and is pending confirmation
      await Promise.resolve();
      await Promise.resolve();

      expect(actions.isDetachPending("CPOLICY")).toBe(true);

      await expect(actions.signWithPolicy("CPOLICY", "payment-xdr")).rejects.toMatchObject({
        name: "PolicySignerLifecycleError",
        code: "POLICY_DETACH_IN_FLIGHT",
        policyContractId: "CPOLICY",
      });

      // Only the detach transaction was signed; the concurrent signWithPolicy was rejected before signing
      expect(calls.signed).toBe(1);
      expect(calls.submitted).toHaveLength(1);

      resolveDetachSubmit({ hash: "detach-hash" });
      await expect(detachPromise).resolves.toEqual({ hash: "detach-hash" });
      expect(actions.isDetachPending("CPOLICY")).toBe(false);
      expect(actions.isPolicyDetached("CPOLICY")).toBe(true);
    });

    it("aborts with POLICY_DETACHED_DURING_SIGN when detach completes right after the sign request starts", async () => {
      const { calls, kit, backend, SignerKey, SignerStore } = fakes();
      let resolvePaymentSign!: (value: string) => void;

      kit.sign.mockImplementation((tx: string) => {
        calls.signed++;
        if (tx === "payment-xdr") {
          return new Promise<string>((resolve) => {
            resolvePaymentSign = resolve;
          });
        }
        return Promise.resolve(`signed:${tx}`);
      });

      const actions = createPolicySignerActions({
        kit: kit as never,
        backend: backend as never,
        network: "testnet",
        SignerKey: SignerKey as never,
        SignerStore: SignerStore as never,
      });

      // Start the sign request first (awaiting user passkey approval in kit.sign)
      const signPromise = actions.signWithPolicy("CPOLICY", "payment-xdr");

      // While sign is in flight, detach starts and completes confirmation
      const detachRes = await actions.detachPolicy("CPOLICY");
      expect(detachRes.hash).toBe("txhash");
      expect(actions.isPolicyDetached("CPOLICY")).toBe(true);

      // Now the in-flight sign request finishes passkey signing right after detach completed
      resolvePaymentSign("signed:payment-xdr");

      await expect(signPromise).rejects.toThrowError(PolicySignerLifecycleError);
      await expect(signPromise).rejects.toMatchObject({
        code: "POLICY_DETACHED_DURING_SIGN",
        policyContractId: "CPOLICY",
      });

      // Only the detach transaction was submitted to the backend; the stale sign request was never submitted
      expect(calls.submitted).toHaveLength(1);
      expect(calls.submitted[0]?.signedXdr).toBe("signed:detach-xdr");
    });

    it("rejects subsequent sign requests after detach has completed until re-attached", async () => {
      const { kit, backend, SignerKey, SignerStore } = fakes();
      const actions = createPolicySignerActions({
        kit: kit as never,
        backend: backend as never,
        network: "testnet",
        SignerKey: SignerKey as never,
        SignerStore: SignerStore as never,
      });

      await actions.detachPolicy("CPOLICY");
      await expect(actions.signWithPolicy("CPOLICY", "tx-after-detach")).rejects.toMatchObject({
        code: "POLICY_ALREADY_DETACHED",
        policyContractId: "CPOLICY",
      });

      // Re-attaching clears the detached state and allows signing again
      await actions.attachPolicy("CPOLICY");
      expect(actions.isPolicyDetached("CPOLICY")).toBe(false);
      await expect(actions.signWithPolicy("CPOLICY", "tx-after-reattach")).resolves.toEqual({
        hash: "txhash",
      });
    });
  });
});
