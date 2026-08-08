import { describe, expect, it } from "vitest";
import { policyAttachArgs } from "./policy-signer";

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
