import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  waitForTransaction: vi.fn(async () => "success" as const),
  createRpcTxStatusReader: vi.fn(() => ({ kind: "reader" })),
  walletConfig: vi.fn(() => ({ rpcUrl: "https://rpc.example" })),
  hasAnalyticsConsent: vi.fn(),
}));

vi.mock("./analytics-consent", () => ({
  hasAnalyticsConsent: mocks.hasAnalyticsConsent,
}));

vi.mock("./config", () => ({
  walletConfig: mocks.walletConfig,
}));

vi.mock("vellar-sdk", () => ({
  waitForTransaction: mocks.waitForTransaction,
}));

vi.mock("vellar-sdk/rpc", () => ({
  createRpcTxStatusReader: mocks.createRpcTxStatusReader,
}));

import { trackTransaction } from "./track";

describe("trackTransaction consent gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not track or queue RPC work before consent is granted", async () => {
    mocks.hasAnalyticsConsent.mockReturnValue(false);

    await expect(trackTransaction("tx-hash-1")).resolves.toBe("success");
    expect(mocks.walletConfig).not.toHaveBeenCalled();
    expect(mocks.createRpcTxStatusReader).not.toHaveBeenCalled();
    expect(mocks.waitForTransaction).not.toHaveBeenCalled();
  });

  it("tracks through RPC once consent is granted", async () => {
    mocks.hasAnalyticsConsent.mockReturnValue(true);

    await expect(trackTransaction("tx-hash-2")).resolves.toBe("success");

    expect(mocks.walletConfig).toHaveBeenCalledTimes(1);
    expect(mocks.createRpcTxStatusReader).toHaveBeenCalledWith({ rpcUrl: "https://rpc.example" });
    expect(mocks.waitForTransaction).toHaveBeenCalledWith({ kind: "reader" }, "tx-hash-2");
  });

  it("never replays pre-consent tracking after consent arrives", async () => {
    mocks.hasAnalyticsConsent.mockReturnValue(false);
    await trackTransaction("pre-consent-hash");

    mocks.hasAnalyticsConsent.mockReturnValue(true);
    await trackTransaction("post-consent-hash");

    expect(mocks.waitForTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.waitForTransaction).toHaveBeenCalledWith({ kind: "reader" }, "post-consent-hash");
  });
});
