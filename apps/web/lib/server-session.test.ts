import { describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import { ensureServerSession } from "./server-session";

const WALLET = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const OTHER = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";

const base: WalletSession = {
  accountId: WALLET,
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-09-26T12:00:00.000Z",
  lastActiveAt: "2026-09-26T12:00:00.000Z",
  keyId: "a2V5LWlk",
};

describe("ensureServerSession (#469: reconnect via derivation skipped /wallet/connect)", () => {
  it("opens a server session when the kit connected without one", async () => {
    const lookupContractId = vi.fn(async () => ({ contractId: WALLET, sessionId: "srv-1" }));
    const out = await ensureServerSession(base, { lookupContractId });
    expect(lookupContractId).toHaveBeenCalledWith({ keyId: "a2V5LWlk", network: "testnet" });
    expect(out).toEqual({ ...base, serverSessionId: "srv-1" });
  });

  it("does not open a second session when the kit's fallback already did", async () => {
    const lookupContractId = vi.fn();
    const session = { ...base, serverSessionId: "srv-0" };
    expect(await ensureServerSession(session, { lookupContractId })).toBe(session);
    expect(lookupContractId).not.toHaveBeenCalled();
  });

  it("ignores a server record for a DIFFERENT wallet than the one verified on-chain", async () => {
    const lookupContractId = vi.fn(async () => ({ contractId: OTHER, sessionId: "srv-x" }));
    const out = await ensureServerSession(base, { lookupContractId });
    expect(out.serverSessionId).toBeUndefined();
    expect(out.accountId).toBe(WALLET);
  });

  it("leaves the session without a bearer when the server doesn't know the passkey (404)", async () => {
    const out = await ensureServerSession(base, { lookupContractId: async () => undefined });
    expect(out.serverSessionId).toBeUndefined();
  });

  it("propagates a server failure instead of reporting a half-open reconnect", async () => {
    const err = new Error("Too many authentication attempts");
    await expect(
      ensureServerSession(base, { lookupContractId: async () => Promise.reject(err) }),
    ).rejects.toBe(err);
  });

  it("does nothing without a keyId (no passkey to look up)", async () => {
    const lookupContractId = vi.fn();
    const { keyId: _omit, ...noKey } = base;
    expect(await ensureServerSession(noKey, { lookupContractId })).toEqual(noKey);
    expect(lookupContractId).not.toHaveBeenCalled();
  });
});
