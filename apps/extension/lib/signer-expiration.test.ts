import { describe, expect, it } from "vitest";
import {
  MAX_EXPIRATION_LEDGERS,
  SignerExpiredError,
  TrustedRpcUnavailableError,
  assertSignerNotExpired,
  boundedExpirationLedger,
  isSignerExpired,
  resolveTrustedRpcUrl,
} from "./signer-expiration";

// L4: the signature-expiration ledger is bounded CLIENT-SIDE off a trusted
// anchor, never widened by the caller-supplied (attacker-controllable) rpcUrl.

describe("boundedExpirationLedger (L4 window cap)", () => {
  it("adds exactly the capped window to the anchor", () => {
    expect(boundedExpirationLedger(1_000)).toBe(1_000 + MAX_EXPIRATION_LEDGERS);
  });

  it("caps the window regardless of how large the anchor is", () => {
    // A hostile RPC inflating the anchor cannot widen the window: the ADDED
    // span is always exactly MAX_EXPIRATION_LEDGERS, never anchor-proportional.
    const huge = 4_000_000_000;
    expect(boundedExpirationLedger(huge) - huge).toBe(MAX_EXPIRATION_LEDGERS);
  });

  it("the cap is 60 ledgers (~5 min at ~5s/ledger)", () => {
    // Named-constant tradeoff: approval latency (user leaves and returns before
    // approving) vs on-chain replay window. 60 covers the worst realistic
    // approval; wider replay is cheap because the device key is a 7-day
    // expiring co-signer bounded further by attached policies.
    expect(MAX_EXPIRATION_LEDGERS).toBe(60);
  });

  it("rejects a non-integer or negative anchor (stays a valid u32)", () => {
    expect(() => boundedExpirationLedger(-1)).toThrow();
    expect(() => boundedExpirationLedger(1.5)).toThrow();
  });

  it("never exceeds u32 max even near the ceiling", () => {
    // If the anchor is already near 2^32, the result must not overflow u32 —
    // the kit asserts u32 and would otherwise throw at signing time.
    const nearMax = 0xffffffff - 10;
    const exp = boundedExpirationLedger(nearMax);
    expect(exp).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(exp)).toBe(true);
  });
});

describe("resolveTrustedRpcUrl (L4 anchor source)", () => {
  it("uses the pinned SDF endpoint for testnet, ignoring any caller rpcUrl", () => {
    expect(resolveTrustedRpcUrl("testnet", undefined)).toBe("https://soroban-testnet.stellar.org");
  });

  it("uses the configured mainnet RPC when present", () => {
    expect(resolveTrustedRpcUrl("mainnet", "https://rpc.mainnet.example")).toBe(
      "https://rpc.mainnet.example",
    );
  });

  it("fails closed on mainnet when no trusted RPC is configured (no fallback to caller)", () => {
    expect(() => resolveTrustedRpcUrl("mainnet", undefined)).toThrow(TrustedRpcUnavailableError);
    expect(() => resolveTrustedRpcUrl("mainnet", "")).toThrow(TrustedRpcUnavailableError);
  });
});

describe("signer expiration timestamp boundary at t - 1ms, t, and t + 1ms (#580)", () => {
  const REQUEST_TIME_T = 1_750_000_000_000;

  it("treats a signer expiring at t - 1ms (1ms before request time) as expired", () => {
    const expiresAt = REQUEST_TIME_T - 1;
    expect(isSignerExpired(expiresAt, REQUEST_TIME_T)).toBe(true);
    expect(() => assertSignerNotExpired(expiresAt, REQUEST_TIME_T)).toThrow(SignerExpiredError);
  });

  it("treats a signer expiring at exact evaluation time t (expiresAt === t) as expired (fail-closed)", () => {
    const expiresAt = REQUEST_TIME_T;
    expect(isSignerExpired(expiresAt, REQUEST_TIME_T)).toBe(true);
    expect(() => assertSignerNotExpired(expiresAt, REQUEST_TIME_T)).toThrow(SignerExpiredError);
    try {
      assertSignerNotExpired(expiresAt, REQUEST_TIME_T);
    } catch (err) {
      expect(err).toBeInstanceOf(SignerExpiredError);
      expect((err as SignerExpiredError).expiresAtMs).toBe(REQUEST_TIME_T);
      expect((err as SignerExpiredError).requestTimeMs).toBe(REQUEST_TIME_T);
    }
  });

  it("treats a signer expiring at t + 1ms (1ms after request time) as still valid", () => {
    const expiresAt = REQUEST_TIME_T + 1;
    expect(isSignerExpired(expiresAt, REQUEST_TIME_T)).toBe(false);
    expect(() => assertSignerNotExpired(expiresAt, REQUEST_TIME_T)).not.toThrow();
  });

  it("rejects non-finite timestamps rather than silently passing NaN comparisons", () => {
    expect(() => isSignerExpired(Number.NaN, REQUEST_TIME_T)).toThrow();
    expect(() => isSignerExpired(REQUEST_TIME_T, Number.NaN)).toThrow();
  });
});
