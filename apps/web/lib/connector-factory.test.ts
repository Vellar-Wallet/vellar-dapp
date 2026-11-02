import { beforeEach, describe, expect, it, vi } from "vitest";

// RA-6 / L-3 (security-audit.md): the V3 detach invariant must hold through the
// REAL connector, not just the pure helper and createPolicySignerActions in
// isolation. policy-signer.test.ts pins the helper and the wiring with a fake
// kit; this file closes the last edge, connector-factory -> policy-signer. A
// refactor that abandons createPolicySignerActions and inlines a SignerLimits
// map in connector-factory must fail HERE.
//
// Deliberately NOT mocked: ./policy-signer. Mocked: only the browser-bound
// edges (passkey-kit, the HTTP backend, config, and the vellar-sdk builders
// that the policy actions never touch).

const POLICY_ID = "CPOLICYCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const SIGNED_XDR = "AAAA-signed-xdr";

const kitCalls: Array<{ method: string; args: unknown[] }> = [];
const submitTransaction = vi.fn(async (_req: { signedXdr: string; network: string }) => ({
  hash: "txhash",
}));

// Sentinel objects so assertions prove WHICH enum member / key reached the kit.
const SIGNER_STORE = { Persistent: { tag: "Persistent" }, Temporary: { tag: "Temporary" } };
const policyKey = (id: string) => ({ tag: "SignerKey.Policy", id });
const SIGNER_KEY = { Policy: vi.fn(policyKey) };

class FakeKit {
  private record(method: string, args: unknown[]) {
    kitCalls.push({ method, args });
  }
  async addPolicy(...args: unknown[]) {
    this.record("addPolicy", args);
    return { tx: "add-policy-tx" };
  }
  async remove(...args: unknown[]) {
    this.record("remove", args);
    return { tx: "remove-tx" };
  }
  async sign(...args: unknown[]) {
    this.record("sign", args);
    return SIGNED_XDR;
  }
  // Any other signer mutation on the policy path is a regression.
  async addEd25519(...args: unknown[]) {
    this.record("addEd25519", args);
    return { tx: "unexpected" };
  }
  async addSecp256r1(...args: unknown[]) {
    this.record("addSecp256r1", args);
    return { tx: "unexpected" };
  }
}

vi.mock("passkey-kit", () => ({
  PasskeyKit: FakeKit,
  SACClient: class {},
  SignerStore: SIGNER_STORE,
  SignerKey: SIGNER_KEY,
}));
vi.mock("vellar-sdk/rpc", () => ({ isValidStellarAddress: () => true }));
vi.mock("vellar-sdk", () => ({
  createPasskeyKitConnector: () => ({}),
  createPaymentClient: () => ({}),
  resumeKitConnection: async () => {},
}));
vi.mock("./http-backend", () => ({
  createHttpWalletBackend: () => ({ submitTransaction }),
}));
vi.mock("./config", () => ({
  walletConfig: () => ({
    apiUrl: "http://api.test",
    network: "testnet",
    rpcUrl: "http://rpc.test",
    networkPassphrase: "Test SDF Network ; September 2015",
    horizonUrl: "http://horizon.test",
    walletWasmHash: "abc",
    appName: "Vellar",
  }),
}));

async function freshRuntime() {
  // getWalletRuntime memoises at module scope; reset so each test builds its own.
  vi.resetModules();
  const { getWalletRuntime } = await import("./connector-factory");
  return getWalletRuntime();
}

const called = (method: string) => kitCalls.filter((c) => c.method === method);

beforeEach(() => {
  kitCalls.length = 0;
  submitTransaction.mockClear();
  SIGNER_KEY.Policy.mockClear();
});

describe("connector-factory -> createPolicySignerActions delegation (RA-6 / L-3)", () => {
  it("attachPolicy reaches kit.addPolicy as a STANDALONE signer: limits and expiration undefined, Persistent store", async () => {
    const runtime = await freshRuntime();

    await runtime.attachPolicy(POLICY_ID);

    const [add] = called("addPolicy");
    expect(called("addPolicy")).toHaveLength(1);
    // Exactly the four positional args, so an extra SignerLimits argument or a
    // reordering cannot hide behind a loose matcher.
    expect(add!.args).toHaveLength(4);
    expect(add!.args[0]).toBe(POLICY_ID);
    expect(add!.args[1]).toBeUndefined(); // SignerLimits(None): the V3 recovery shape
    expect(add!.args[2]).toBe(SIGNER_STORE.Persistent);
    expect(add!.args[3]).toBeUndefined(); // revoked by removal, not by TTL
  });

  it("attachPolicy signs once and submits the signed xdr on the configured network", async () => {
    const runtime = await freshRuntime();

    const result = await runtime.attachPolicy(POLICY_ID);

    expect(called("sign")).toHaveLength(1);
    expect(submitTransaction).toHaveBeenCalledTimes(1);
    expect(submitTransaction).toHaveBeenCalledWith({ signedXdr: SIGNED_XDR, network: "testnet" });
    expect(result).toEqual({ hash: "txhash" });
  });

  it("attachPolicy never takes another signer-mutation path", async () => {
    const runtime = await freshRuntime();

    await runtime.attachPolicy(POLICY_ID);

    expect(called("addEd25519")).toHaveLength(0);
    expect(called("addSecp256r1")).toHaveLength(0);
    expect(called("remove")).toHaveLength(0);
  });

  it("detachPolicy removes exactly SignerKey.Policy(id): the key the wallet's self-removal exception recognises", async () => {
    const runtime = await freshRuntime();

    await runtime.detachPolicy(POLICY_ID);

    expect(SIGNER_KEY.Policy).toHaveBeenCalledTimes(1);
    expect(SIGNER_KEY.Policy).toHaveBeenCalledWith(POLICY_ID);
    const [remove] = called("remove");
    expect(called("remove")).toHaveLength(1);
    expect(remove!.args).toHaveLength(1);
    expect(remove!.args[0]).toEqual(policyKey(POLICY_ID));
  });

  it("detachPolicy signs once and submits the signed xdr on the configured network", async () => {
    const runtime = await freshRuntime();

    const result = await runtime.detachPolicy(POLICY_ID);

    expect(called("sign")).toHaveLength(1);
    expect(submitTransaction).toHaveBeenCalledWith({ signedXdr: SIGNED_XDR, network: "testnet" });
    expect(result).toEqual({ hash: "txhash" });
  });

  it("detachPolicy never adds or attaches anything", async () => {
    const runtime = await freshRuntime();

    await runtime.detachPolicy(POLICY_ID);

    expect(called("addPolicy")).toHaveLength(0);
    expect(called("addEd25519")).toHaveLength(0);
    expect(called("addSecp256r1")).toHaveLength(0);
  });

  it("does not use the Temporary store, which would expire the policy signer", async () => {
    const runtime = await freshRuntime();

    await runtime.attachPolicy(POLICY_ID);

    expect(called("addPolicy")[0]!.args[2]).not.toBe(SIGNER_STORE.Temporary);
  });

  it("propagates a kit failure instead of reporting a hash (attach)", async () => {
    const runtime = await freshRuntime();
    vi.spyOn(FakeKit.prototype, "addPolicy").mockRejectedValueOnce(new Error("passkey cancelled"));

    await expect(runtime.attachPolicy(POLICY_ID)).rejects.toThrow("passkey cancelled");
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("propagates a kit failure instead of reporting a hash (detach)", async () => {
    const runtime = await freshRuntime();
    vi.spyOn(FakeKit.prototype, "remove").mockRejectedValueOnce(new Error("passkey cancelled"));

    await expect(runtime.detachPolicy(POLICY_ID)).rejects.toThrow("passkey cancelled");
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("does not submit when the backend rejects, and surfaces the error", async () => {
    const runtime = await freshRuntime();
    submitTransaction.mockRejectedValueOnce(new Error("backend 503"));

    await expect(runtime.detachPolicy(POLICY_ID)).rejects.toThrow("backend 503");
  });

  it("shares ONE kit across attach and detach (the connected passkey lives in it)", async () => {
    const runtime = await freshRuntime();
    const ctor = vi.spyOn(FakeKit.prototype, "sign");

    await runtime.attachPolicy(POLICY_ID);
    await runtime.detachPolicy(POLICY_ID);

    // Both flows signed through the same instance: the kit calls interleave in
    // one log rather than two separate runtimes.
    expect(kitCalls.map((c) => c.method)).toEqual(["addPolicy", "sign", "remove", "sign"]);
    ctor.mockRestore();
  });
});
