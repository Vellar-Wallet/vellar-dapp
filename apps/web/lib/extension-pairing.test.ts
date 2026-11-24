import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import {
  PAIRING_ALLOWED_ORIGINS,
  PairingOriginError,
  assertPairingOriginAllowed,
  checkPairingStatus,
  getPairingAllowedOrigins,
  isPairingOriginAllowed,
  pairExtension,
  resetPairingAllowedOrigins,
  setPairingAllowedOrigins,
} from "./extension-pairing";

// The wallet runtime is only reached after the extension consent step; the
// #849 tests below drive pairing that far, so give them a controllable double.
const runtime = vi.hoisted(() => ({
  resume: vi.fn(async () => {}),
  addDeviceSigner: vi.fn(async () => ({ hash: "tx-hash", expiresAt: "2099-01-01T00:00:00Z" })),
}));
vi.mock("./connector-factory", () => ({ getWalletRuntime: vi.fn(async () => runtime) }));

const session = {
  accountId: "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67",
  network: "testnet",
  keyId: "key-1",
} as WalletSession;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPairingAllowedOrigins();
  runtime.resume.mockClear();
  runtime.addDeviceSigner.mockClear();
});

describe("pairing origin allowlist (L3 fail-closed)", () => {
  it("allows the canonical web-app origins", () => {
    for (const origin of [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://app.vellar.xyz",
      "https://vellar.xyz",
    ]) {
      expect(isPairingOriginAllowed(origin)).toBe(true);
      expect(() => assertPairingOriginAllowed(origin)).not.toThrow();
    }
  });

  it("rejects a disallowed origin with a clear, logged reason", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isPairingOriginAllowed("https://evil.example.com")).toBe(false);
    expect(() => assertPairingOriginAllowed("https://evil.example.com")).toThrow(
      PairingOriginError,
    );
    expect(() => assertPairingOriginAllowed("https://evil.example.com")).toThrow(
      /not permitted from this origin: https:\/\/evil\.example\.com/,
    );
    expect(warn).toHaveBeenCalledWith(
      "[extension-pairing] rejected pairing request from origin https://evil.example.com",
    );
  });

  it("rejects a near-miss subdomain of an allowed origin", () => {
    // "app.vellar.xyz" is allowed; a subdomain of it is a different principal.
    expect(isPairingOriginAllowed("https://app.vellar.xyz")).toBe(true);
    expect(isPairingOriginAllowed("https://evil.app.vellar.xyz")).toBe(false);
    expect(isPairingOriginAllowed("https://app.vellar.xyz.evil.com")).toBe(false);
    expect(() => assertPairingOriginAllowed("https://evil.app.vellar.xyz")).toThrow(
      PairingOriginError,
    );
  });

  it("treats a single trailing-dot FQDN as the same origin (L5), not a near-miss", () => {
    // L5: "app.vellar.xyz." denotes the same FQDN; normalizeOrigin collapses it
    // so the dotted and dotless forms share one allowlist entry.
    expect(isPairingOriginAllowed("https://app.vellar.xyz.")).toBe(true);
    expect(() => assertPairingOriginAllowed("https://app.vellar.xyz.")).not.toThrow();
    // A doubled trailing dot is NOT collapsed and stays off the list.
    expect(isPairingOriginAllowed("https://app.vellar.xyz..")).toBe(false);
  });

  it("fails closed on malformed origins (path, query, non-http, empty)", () => {
    for (const origin of [
      "",
      "not-a-url",
      "https://app.vellar.xyz/path",
      "https://app.vellar.xyz?x=1",
      "file:///etc/passwd",
      "null",
    ]) {
      expect(isPairingOriginAllowed(origin)).toBe(false);
    }
  });
});

describe("pairExtension rejects a disallowed origin before any extension call", () => {
  it("throws PairingOriginError and never reaches the injected provider", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pair = vi.fn();
    vi.stubGlobal("window", {
      location: { origin: "https://evil.example.com" },
      vela: { pair, pairStatus: vi.fn() },
    });

    await expect(pairExtension(session)).rejects.toBeInstanceOf(PairingOriginError);
    expect(pair).not.toHaveBeenCalled();
  });

  it("proceeds past the gate on an allowed origin (provider missing is a later error)", async () => {
    vi.stubGlobal("window", {
      location: { origin: "https://app.vellar.xyz" },
      // No injected provider: the origin gate passed, the next guard fires.
    });

    await expect(pairExtension(session)).rejects.toThrow(
      "The Vellar extension is not installed in this browser",
    );
  });
});

describe("allowlist is re-checked per action, not frozen at session start (#849)", () => {
  const ORIGIN = "https://app.vellar.xyz";
  const revoke = () =>
    setPairingAllowedOrigins(PAIRING_ALLOWED_ORIGINS.filter((o) => o !== ORIGIN));

  function stubWindow(provider: Record<string, unknown>) {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      location: { origin: ORIGIN },
      vela: provider,
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
      },
    });
    return storage;
  }

  it("happy path: an origin that stays allowed pairs end to end", async () => {
    const pair = vi.fn(async () => ({ devicePublicKeyHex: "ab".repeat(32) }));
    stubWindow({ pair, pairStatus: vi.fn() });

    await expect(pairExtension(session)).resolves.toEqual({
      hash: "tx-hash",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    expect(pair).toHaveBeenCalledOnce();
    expect(runtime.addDeviceSigner).toHaveBeenCalledWith("ab".repeat(32));
  });

  it("an origin removed from the allowlist is refused on the NEXT action of an open session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pair = vi.fn(async () => ({ devicePublicKeyHex: "ab".repeat(32) }));
    stubWindow({ pair, pairStatus: vi.fn() });

    // Session starts while the origin is allowed and pairs successfully…
    await pairExtension(session);
    expect(pair).toHaveBeenCalledTimes(1);

    // …then the origin is removed. The same session's next attempt must be
    // judged against the current list, not the one in force at session start.
    revoke();
    await expect(pairExtension(session)).rejects.toBeInstanceOf(PairingOriginError);
    expect(pair).toHaveBeenCalledTimes(1);
  });

  it("revocation DURING the extension prompt stops the on-chain signer from being added", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The allowlist changes while the user is looking at the extension popup.
    const pair = vi.fn(async () => {
      revoke();
      return { devicePublicKeyHex: "ab".repeat(32) };
    });
    const storage = stubWindow({ pair, pairStatus: vi.fn() });

    await expect(pairExtension(session)).rejects.toBeInstanceOf(PairingOriginError);
    expect(pair).toHaveBeenCalledOnce(); // gate passed at the start…
    expect(runtime.addDeviceSigner).not.toHaveBeenCalled(); // …but nothing reached the chain
    expect(storage.size).toBe(0); // and no pairing was remembered
  });

  it("revocation while the passkey runtime resumes still blocks addDeviceSigner", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runtime.resume.mockImplementationOnce(async () => {
      revoke();
    });
    stubWindow({
      pair: vi.fn(async () => ({ devicePublicKeyHex: "ab".repeat(32) })),
      pairStatus: vi.fn(),
    });

    await expect(pairExtension(session)).rejects.toBeInstanceOf(PairingOriginError);
    expect(runtime.addDeviceSigner).not.toHaveBeenCalled();
  });

  it("checkPairingStatus fails closed (false) without asking the extension once the origin is revoked", async () => {
    const pairStatus = vi.fn(async () => ({ paired: true }));
    stubWindow({ pair: vi.fn(), pairStatus });

    await expect(checkPairingStatus(session)).resolves.toBe(true);
    expect(pairStatus).toHaveBeenCalledTimes(1);

    revoke();
    await expect(checkPairingStatus(session)).resolves.toBe(false);
    expect(pairStatus).toHaveBeenCalledTimes(1);
  });

  it("re-adding the origin restores access for the same open session", async () => {
    const pairStatus = vi.fn(async () => ({ paired: true }));
    stubWindow({ pair: vi.fn(), pairStatus });

    revoke();
    await expect(checkPairingStatus(session)).resolves.toBe(false);
    resetPairingAllowedOrigins();
    await expect(checkPairingStatus(session)).resolves.toBe(true);
  });

  it("setPairingAllowedOrigins normalizes entries and drops malformed ones (never widens)", () => {
    setPairingAllowedOrigins(["https://app.vellar.xyz.", "not-a-url", "https://x.example/path"]);
    expect(getPairingAllowedOrigins()).toEqual(["https://app.vellar.xyz"]);
    expect(isPairingOriginAllowed("https://app.vellar.xyz")).toBe(true);
    expect(isPairingOriginAllowed("https://vellar.xyz")).toBe(false);
  });

  it("an empty allowlist refuses every origin (fail-closed)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setPairingAllowedOrigins([]);
    for (const origin of PAIRING_ALLOWED_ORIGINS) {
      expect(isPairingOriginAllowed(origin)).toBe(false);
      expect(() => assertPairingOriginAllowed(origin)).toThrow(PairingOriginError);
    }
  });
});
