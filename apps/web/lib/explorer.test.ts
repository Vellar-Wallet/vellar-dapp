import { describe, expect, it } from "vitest";
import { explorerTxUrl } from "./explorer";

describe("explorerTxUrl (#600)", () => {
  const txHash = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

  it("maps mainnet to the public stellar.expert explorer URL", () => {
    expect(explorerTxUrl(txHash, "mainnet")).toBe(
      `https://stellar.expert/explorer/public/tx/${txHash}`,
    );
  });

  it("maps testnet to the testnet stellar.expert explorer URL", () => {
    expect(explorerTxUrl(txHash, "testnet")).toBe(
      `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    );
  });

  it("normalizes uppercase/mixed-case network values (e.g. MAINNET -> mainnet, not testnet)", () => {
    expect(explorerTxUrl(txHash, "MAINNET")).toBe(
      `https://stellar.expert/explorer/public/tx/${txHash}`,
    );
    expect(explorerTxUrl(txHash, "Testnet")).toBe(
      `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    );
  });

  it("throws an explicit error for unknown or empty networks instead of silently falling through", () => {
    expect(() => explorerTxUrl(txHash, "futurenet")).toThrow(
      /Unsupported Stellar explorer network "futurenet"/i,
    );
    expect(() => explorerTxUrl(txHash, "")).toThrow(/Unsupported Stellar explorer network ""/i);
    expect(() => explorerTxUrl(txHash, "devnet")).toThrow(
      /Unsupported Stellar explorer network "devnet"/i,
    );
  });
});
