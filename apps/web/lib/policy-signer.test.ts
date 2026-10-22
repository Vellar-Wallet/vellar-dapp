import { describe, expect, it, vi } from "vitest";
import { createPolicySignerActions, policyAttachArgs } from "./policy-signer";

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
});

// Issue #559: a signature request issued while a detach transaction for the
// same policy is still pending confirmation. The behaviour is deliberate —
// the sign request is REJECTED with a clear reason rather than racing the
// recovery path — and the guard clears as soon as the detach resolves.
describe("requestSignature vs in-flight detach (issue #559)", () => {
  function fakes(opts: { detachGate?: Promise<void> } = {}) {
    const calls = {
      remove: [] as unknown[],
      signed: 0,
      submitted: [] as { signedXdr: string; network: string }[],
    };
    const kit = {
      addPolicy: vi.fn(async () => "attach-xdr"),
      remove: vi.fn(async (signerKey: unknown) => {
        calls.remove.push(signerKey);
        // Hold the detach open until the test releases it, so the transaction
        // is "pending confirmation" while the sign request arrives.
        if (opts.detachGate) await opts.detachGate;
        return "detach-xdr";
      }),
      sign: vi.fn(async (tx: string) => {
        calls.signed++;
        return `signed:${tx}`;
      }),
    };
    const SignerKey = { Policy: (id: string) => ({ tag: "Policy", id }) };
    const SignerStore = { Persistent: "PERSISTENT", Temporary: "TEMPORARY" };
    const backend = {
      submitTransaction: vi.fn(async (req: { signedXdr: string; network: string }) => {
        calls.submitted.push(req);
        return { hash: "txhash" };
      }),
    };
    return { calls, kit, backend, SignerKey, SignerStore };
  }

  function actionsOf(f: ReturnType<typeof fakes>) {
    return createPolicySignerActions({
      kit: f.kit as never,
      backend: f.backend as never,
      network: "testnet",
      SignerKey: f.SignerKey as never,
      SignerStore: f.SignerStore as never,
    });
  }

  it("rejects a sign request issued while the same policy is mid-detach, with a clear reason", async () => {
    let releaseDetach!: () => void;
    const detachGate = new Promise<void>((resolve) => {
      releaseDetach = resolve;
    });
    const f = fakes({ detachGate });
    const actions = actionsOf(f);

    // Start the detach; it stays pending confirmation (gate held).
    const detachPromise = actions.detachPolicy("CPOLICY");
    await Promise.resolve(); // let detach reach the gate

    // Sign request arrives while the detach is still pending → rejected.
    await expect(actions.requestSignature("CPOLICY", "pending-tx")).rejects.toThrow(
      /being detached/i,
    );

    releaseDetach();
    await expect(detachPromise).resolves.toEqual({ hash: "txhash" });
    // The rejection is a guard, not a sign: only the detach itself signed.
    expect(f.calls.signed).toBe(1);
  });

  it("does not block a sign request for a different policy", async () => {
    let releaseDetach!: () => void;
    const detachGate = new Promise<void>((resolve) => {
      releaseDetach = resolve;
    });
    const f = fakes({ detachGate });
    const actions = actionsOf(f);

    const detachPromise = actions.detachPolicy("CPOLICY");
    await Promise.resolve();

    await expect(actions.requestSignature("COTHER", "other-tx")).resolves.toBe("signed:other-tx");

    releaseDetach();
    await detachPromise;
  });

  it("allows a sign request after the detach has confirmed", async () => {
    const f = fakes();
    const actions = actionsOf(f);

    await actions.detachPolicy("CPOLICY");
    await expect(actions.requestSignature("CPOLICY", "tx-after")).resolves.toBe("signed:tx-after");
  });

  it("covers the detach completing successfully right after the sign request starts", async () => {
    let releaseDetach!: () => void;
    const detachGate = new Promise<void>((resolve) => {
      releaseDetach = resolve;
    });
    const f = fakes({ detachGate });
    const actions = actionsOf(f);

    // Sign request starts FIRST (no detach in flight yet) — it is allowed
    // and left in flight.
    const signPromise = actions.requestSignature("CPOLICY", "early-tx");

    // Detach for the same policy starts and completes right after.
    const detachPromise = actions.detachPolicy("CPOLICY");
    releaseDetach();
    await expect(detachPromise).resolves.toEqual({ hash: "txhash" });

    // The already-started sign request is not retroactively failed; it
    // resolves normally (the guard is checked at initiation only).
    await expect(signPromise).resolves.toBe("signed:early-tx");

    // And the guard has cleared: a fresh sign request is allowed again.
    await expect(actions.requestSignature("CPOLICY", "late-tx")).resolves.toBe("signed:late-tx");
  });
});
