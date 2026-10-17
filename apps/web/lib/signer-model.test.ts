import { describe, expect, it } from "vitest";
import {
  canRevokeSigner,
  classifySigners,
  classifySignerType,
  getSignerCategory,
  isDeviceSigner,
  isLastPasskey,
  isPasskeySigner,
  isPolicySigner,
  signerMutationErrorMessage,
  walletContractErrorCode,
  type RawSigner,
} from "./signer-model";

const WALLET = "CWALLET";
const opts = { currentKeyId: "cred-1", walletAddress: WALLET };

const passkey = (value: string, over: Partial<RawSigner> = {}): RawSigner => ({
  key: { key: "Secp256r1", value },
  storage: "persistent",
  status: "live",
  ...over,
});
const ed = (value: string, over: Partial<RawSigner> = {}): RawSigner => ({
  key: { key: "Ed25519", value },
  storage: "persistent",
  status: "live",
  ...over,
});
const policy = (value: string): RawSigner => ({
  key: { key: "Policy", value },
  storage: "persistent",
  status: "live",
});

describe("classifySigners", () => {
  it("distinguishes passkey / device session / agent / policy from the on-chain fields", () => {
    const rows: RawSigner[] = [
      policy("CPOLICY"),
      ed("GAGENT", { limits: new Map([["CTOKEN", [{ key: "Policy", value: "CPOLICY" }]]]) }),
      ed("GDEVICE", { storage: "temporary", expiration: 1_800_000_000 }),
      passkey("cred-2"),
      passkey("cred-1"),
    ];
    const entries = classifySigners(rows, opts);
    expect(entries.map((e) => [e.kind, e.key.value])).toEqual([
      ["passkey", "cred-1"],
      ["passkey", "cred-2"],
      ["device-session", "GDEVICE"],
      ["agent", "GAGENT"],
      ["policy", "CPOLICY"],
    ]);
    expect(entries[0]!.isCurrent).toBe(true);
    expect(entries[1]!.isCurrent).toBe(false);
    expect(entries[2]!.expiresAt).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(entries[3]!.limits).toEqual([
      { contract: "CTOKEN", requiredCoSigners: [{ kind: "Policy", value: "CPOLICY" }] },
    ]);
  });

  it("treats an unlimited persistent Ed25519 as an agent, never a bounded session", () => {
    const [e] = classifySigners([ed("GFULL")], opts);
    expect(e!.kind).toBe("agent");
    expect(e!.limits).toBeUndefined();
    expect(e!.isDurableAdmin).toBe(true);
  });

  it("drops removed tombstones — the chain no longer has them", () => {
    const entries = classifySigners([passkey("gone", { status: "removed" }), passkey("x")], opts);
    expect(entries.map((e) => e.key.value)).toEqual(["x"]);
  });

  it("mirrors the contract's durable-admin rule", () => {
    const [unlimited, expiring, temporary, limitedAdmin, limitedOther] = classifySigners(
      [
        passkey("a"),
        passkey("b", { expiration: 1 }),
        passkey("c", { storage: "temporary" }),
        ed("d", { limits: new Map([[WALLET, undefined]]) }),
        ed("e", { limits: new Map([["COTHER", undefined]]) }),
      ],
      opts,
    );
    expect(unlimited!.isDurableAdmin).toBe(true);
    expect(expiring!.isDurableAdmin).toBe(false);
    expect(temporary!.isDurableAdmin).toBe(false);
    expect(limitedAdmin!.isDurableAdmin).toBe(true);
    expect(limitedOther!.isDurableAdmin).toBe(false);
  });
});

describe("lockout protection", () => {
  it("2 passkeys → revoking one is allowed", () => {
    const entries = classifySigners([passkey("cred-1"), passkey("cred-2")], opts);
    expect(isLastPasskey(entries[1]!, entries)).toBe(false);
    expect(canRevokeSigner(entries[1]!, entries)).toEqual({ allowed: true });
  });

  it("1 passkey → revoking it is blocked, even with agent keys present", () => {
    const entries = classifySigners(
      [passkey("cred-1"), ed("GAGENT", { limits: new Map([["CTOKEN", []]]) })],
      opts,
    );
    const only = entries.find((e) => e.kind === "passkey")!;
    expect(isLastPasskey(only, entries)).toBe(true);
    expect(canRevokeSigner(only, entries)).toEqual({ allowed: false, reason: "last-passkey" });
  });

  it("an expired passkey does not count as a surviving passkey", () => {
    const entries = classifySigners(
      [passkey("cred-1"), passkey("cred-2", { status: "expired", expiration: 1 })],
      opts,
    );
    expect(canRevokeSigner(entries[0]!, entries)).toEqual({
      allowed: false,
      reason: "last-passkey",
    });
  });

  it("non-passkey signers are always revocable by the passkey", () => {
    const entries = classifySigners(
      [passkey("cred-1"), ed("GDEVICE", { storage: "temporary" }), policy("CPOLICY")],
      opts,
    );
    expect(canRevokeSigner(entries[1]!, entries)).toEqual({ allowed: true });
    expect(canRevokeSigner(entries[2]!, entries)).toEqual({ allowed: true });
  });

  it("blocks removing the last durable admin when the only other passkey is not durable", () => {
    const entries = classifySigners(
      [passkey("cred-1"), passkey("cred-2", { expiration: 4_102_444_800 })],
      opts,
    );
    expect(canRevokeSigner(entries[0]!, entries)).toEqual({
      allowed: false,
      reason: "last-durable-admin",
    });
  });
});

describe("wallet contract error mapping", () => {
  it("decodes the wallet's LastAdminSigner / LastSigner refusals", () => {
    expect(walletContractErrorCode(new Error("HostError: Error(Contract, #103)"))).toBe(103);
    expect(signerMutationErrorMessage(new Error("Error(Contract, #103)"), "x")).toMatch(
      /lock you out/,
    );
    expect(signerMutationErrorMessage(new Error("Error(Contract, #104)"), "x")).toMatch(
      /lock you out/,
    );
    expect(signerMutationErrorMessage(new Error("Error(Contract, #101)"), "x")).toMatch(
      /already exists/,
    );
    expect(signerMutationErrorMessage(new Error("boom"), "fallback")).toBe("fallback");
  });
});

describe("shared signer category classifier (#594)", () => {
  it("distinguishes passkey, policy, and device signers across SignerEntry, RawSigner, and SignerKeyRef shapes", () => {
    const entries = classifySigners(
      [
        passkey("cred-1"),
        ed("GDEVICE", { storage: "temporary", expiration: 1_800_000_000 }),
        policy("CPOLICY"),
      ],
      opts,
    );

    const [passkeyEntry, deviceEntry, policyEntry] = entries;

    expect(classifySignerType(passkeyEntry)).toBe("passkey");
    expect(classifySignerType(passkey("cred-1"))).toBe("passkey");
    expect(classifySignerType({ kind: "Secp256r1", value: "cred-1" })).toBe("passkey");
    expect(isPasskeySigner(passkeyEntry)).toBe(true);
    expect(isPolicySigner(passkeyEntry)).toBe(false);
    expect(isDeviceSigner(passkeyEntry)).toBe(false);

    expect(classifySignerType(policyEntry)).toBe("policy");
    expect(classifySignerType(policy("CPOLICY"))).toBe("policy");
    expect(classifySignerType({ kind: "Policy", value: "CPOLICY" })).toBe("policy");
    expect(isPolicySigner(policyEntry)).toBe(true);
    expect(isPolicySigner(policyEntry, "CPOLICY")).toBe(true);
    expect(isPolicySigner(policyEntry, "COTHER")).toBe(false);

    expect(classifySignerType(deviceEntry)).toBe("device");
    expect(classifySignerType(ed("GDEVICE", { storage: "temporary" }))).toBe("device");
    expect(classifySignerType({ kind: "Ed25519", value: "GDEVICE" })).toBe("device");
    expect(isDeviceSigner(deviceEntry)).toBe(true);
    expect(getSignerCategory(deviceEntry)).toBe("device");
  });

  it("returns 'unknown' and never throws on unrecognized or malformed signer inputs", () => {
    const [agentEntry] = classifySigners(
      [ed("GAGENT", { limits: new Map([["CTOKEN", [{ key: "Policy", value: "CPOLICY" }]]]) })],
      opts,
    );
    expect(classifySignerType(agentEntry)).toBe("unknown");
    expect(classifySignerType(null)).toBe("unknown");
    expect(classifySignerType(undefined)).toBe("unknown");
    expect(classifySignerType("not-an-object")).toBe("unknown");
    expect(classifySignerType({})).toBe("unknown");
    expect(classifySignerType({ kind: "unknown-future-signer" })).toBe("unknown");
    expect(classifySignerType({ key: { key: "UnknownCurve", value: "x" } })).toBe("unknown");
  });
});
