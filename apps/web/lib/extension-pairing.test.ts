import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import type { VelaProvider } from "@vellar/provider-sdk";
import {
  assertAllowedPairingOrigin,
  checkPairingStatus,
  DEFAULT_ALLOWED_PAIRING_ORIGINS,
  DisallowedPairingOriginError,
  pairExtension,
  recallPairing,
  validatePairingOrigin,
} from "./extension-pairing";

const { runtimeMock } = vi.hoisted(() => ({ runtimeMock: vi.fn() }));
vi.mock("./connector-factory", () => ({
  getWalletRuntime: runtimeMock,
}));

vi.mock("./config", () => ({
  walletConfig: () => ({
    rpcUrl: "https://soroban-testnet.stellar.org",
    walletWasmHash: "ab".repeat(32),
  }),
}));

const session: WalletSession = {
  accountId: "CSMARTWALLET",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T09:00:00.000Z",
  lastActiveAt: "2026-07-16T09:00:00.000Z",
  keyId: "cred-1",
};

function installProvider(overrides: Partial<VelaProvider> = {}): VelaProvider {
  const provider: VelaProvider = {
    isVellar: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getAddress: vi.fn(),
    getNetwork: vi.fn(),
    signTransaction: vi.fn(),
    signAuthEntry: vi.fn(),
    signMessage: vi.fn(),
    pair: vi.fn(async () => ({
      devicePublicKeyHex: "11".repeat(32),
      address: session.accountId,
      network: session.network,
    })),
    pairStatus: vi.fn(async () => ({ paired: true })),
    ...overrides,
  };
  (window as { vela?: VelaProvider }).vela = provider;
  return provider;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  delete (window as { vela?: VelaProvider }).vela;
  runtimeMock.mockResolvedValue({
    resume: vi.fn(async () => undefined),
    addDeviceSigner: vi.fn(async () => ({
      hash: "pairtx123",
      expiresAt: "2026-07-23T09:00:00.000Z",
    })),
  });
});

describe("extension-pairing origin validation (#564)", () => {
  it("accepts exact allowlisted origins and completes pairing", async () => {
    const provider = installProvider();

    const res = await pairExtension(session, {
      origin: "https://app.vellar.xyz",
      allowedOrigins: DEFAULT_ALLOWED_PAIRING_ORIGINS,
    });

    expect(res).toEqual({
      hash: "pairtx123",
      expiresAt: "2026-07-23T09:00:00.000Z",
    });
    expect(provider.pair).toHaveBeenCalledWith({
      address: "CSMARTWALLET",
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      keyId: "cred-1",
      walletWasmHash: "ab".repeat(32),
    });
    expect(recallPairing("CSMARTWALLET")).toEqual(res);
  });

  it("rejects a completely disallowed origin, logs a clear reason, and never calls provider.pair or addDeviceSigner", async () => {
    const provider = installProvider();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      pairExtension(session, {
        origin: "https://evil-phishing.example",
        allowedOrigins: ["https://app.vellar.xyz"],
      }),
    ).rejects.toThrow(DisallowedPairingOriginError);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[Pairing\] Rejected pairing request from disallowed origin "https:\/\/evil-phishing\.example".*not in the pairing allowlist/i,
      ),
    );
    expect(provider.pair).not.toHaveBeenCalled();
    expect(runtimeMock).not.toHaveBeenCalled();
    expect(recallPairing("CSMARTWALLET")).toBeUndefined();
    errorSpy.mockRestore();
  });

  it.each([
    ["https://sub.app.vellar.xyz", /Subdomain "sub\.app\.vellar\.xyz" is not permitted/i],
    ["https://evil.vellar.xyz", /Subdomain "evil\.vellar\.xyz" is not permitted/i],
    [
      "https://app.vellar.xyz.",
      /Trailing-dot hostname variant "app\.vellar\.xyz\." is not permitted/i,
    ],
    ["https://vellar.xyz.", /Trailing-dot hostname variant "vellar\.xyz\." is not permitted/i],
    ["https://app.vellar.xyz.evil.com", /not in the pairing allowlist/i],
    ["https://app-vellar.xyz", /not in the pairing allowlist/i],
    ["http://app.vellar.xyz", /Protocol mismatch "http:" for host "app\.vellar\.xyz"/i],
    ["https://app.vellar.xyz:8443", /Port mismatch "8443" for host "app\.vellar\.xyz"/i],
    ["https://app.vellar.xyz/settings", /bare scheme:\/\/host/i],
    ["https://user:pass@app.vellar.xyz", /must not contain credentials/i],
    ["javascript:alert(1)", /Unsupported protocol/i],
    ["null", /empty or opaque/i],
  ])(
    "rejects near-miss or malformed origin %s with a clear logged reason",
    async (candidateOrigin, expectedReasonPattern) => {
      const provider = installProvider();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const allowlist = ["https://app.vellar.xyz", "https://vellar.xyz"];

      const validation = validatePairingOrigin(candidateOrigin, allowlist);
      expect(validation.allowed).toBe(false);
      expect(validation.reason).toMatch(expectedReasonPattern);

      expect(() => assertAllowedPairingOrigin(candidateOrigin, allowlist)).toThrow(
        DisallowedPairingOriginError,
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(expectedReasonPattern));

      await expect(
        pairExtension(session, { origin: candidateOrigin, allowedOrigins: allowlist }),
      ).rejects.toThrow(DisallowedPairingOriginError);
      expect(provider.pair).not.toHaveBeenCalled();
      expect(runtimeMock).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    },
  );

  it("checks pairing status safely via the injected provider", async () => {
    expect(await checkPairingStatus(session)).toBe(false);
    installProvider({ pairStatus: vi.fn(async () => ({ paired: true })) });
    expect(await checkPairingStatus(session)).toBe(true);
  });
});
