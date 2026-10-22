import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import {
  PairingOriginError,
  assertPairingOriginAllowed,
  isPairingOriginAllowed,
  pairExtension,
} from "./extension-pairing";

const session = {
  accountId: "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67",
  network: "testnet",
  keyId: "key-1",
} as WalletSession;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    expect(() => assertPairingOriginAllowed("https://evil.example.com")).toThrow(PairingOriginError);
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
