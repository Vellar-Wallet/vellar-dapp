import { describe, expect, it, vi } from "vitest";
import { detachPolicy, type PolicyDetachRuntime } from "./policy";

describe("detachPolicy (V3/FIX 5 recovery path)", () => {
  it("reconnects (resume) then removes the policy signer, returning the tx hash", async () => {
    const order: string[] = [];
    const runtime: PolicyDetachRuntime = {
      resume: vi.fn(async () => {
        order.push("resume");
      }),
      detachPolicy: vi.fn(async () => {
        order.push("detach");
        return { hash: "removaltx" };
      }),
    };
    const res = await detachPolicy("CPOLICY", { keyId: "key-1" }, runtime);
    expect(res.hash).toBe("removaltx");
    expect(order).toEqual(["resume", "detach"]);
    expect(runtime.detachPolicy).toHaveBeenCalledWith("CPOLICY");
  });

  it("removes without resume when no keyId is present", async () => {
    const runtime: PolicyDetachRuntime = {
      detachPolicy: vi.fn(async () => ({ hash: "h" })),
    };
    await detachPolicy("CPOLICY", {}, runtime);
    expect(runtime.detachPolicy).toHaveBeenCalledWith("CPOLICY");
  });

  it("removal does not depend on policy state — a reject-everything policy is still removable", async () => {
    // The detach path never invokes the policy contract's policy__ (the wallet's
    // is_sole_self_removal exception skips it), so a policy that rejects all
    // authorizations does not block its own removal. The fake mirrors that: it
    // resolves regardless of any policy behavior.
    const runtime: PolicyDetachRuntime = {
      detachPolicy: vi.fn(async () => ({ hash: "unbricked" })),
    };
    const res = await detachPolicy("C_REJECTS_EVERYTHING", {}, runtime);
    expect(res.hash).toBe("unbricked");
  });
});
