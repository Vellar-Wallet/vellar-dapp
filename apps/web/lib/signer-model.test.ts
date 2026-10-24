import { describe, expect, it } from "vitest";
import {
  canRevokeSigner,
  classifySigners,
  isLastPasskey,
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

  it("classifies a signer key kind outside the known set as 'unknown' rather than throwing (#594)", () => {
    // `RawSigner.key.key`'s declared type is a closed union, but this models
    // data read from the on-chain indexer — malformed or future indexer
    // output isn't something the type system can rule out at runtime. The
    // `as RawSigner` cast simulates exactly that: a value TypeScript would
    // never let through a normal construction.
    const weird = {
      key: { key: "Unrecognized", value: "X" },
      storage: "persistent",
      status: "live",
    } as unknown as RawSigner;

    expect(() => classifySigners([weird], opts)).not.toThrow();
    const [entry] = classifySigners([weird], opts);
    expect(entry!.kind).toBe("unknown");
    expect(entry!.key.value).toBe("X");
  });

  it("sorts unknown-kind signers last, after policies", () => {
    const weird = {
      key: { key: "Unrecognized", value: "X" },
      storage: "persistent",
      status: "live",
    } as unknown as RawSigner;
    const entries = classifySigners([weird, policy("CPOLICY"), passkey("cred-1")], opts);
    expect(entries.map((e) => e.kind)).toEqual(["passkey", "policy", "unknown"]);
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
