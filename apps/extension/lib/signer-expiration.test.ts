import { describe, expect, it } from "vitest";
import {
  MAX_EXPIRATION_LEDGERS,
  TrustedRpcUnavailableError,
  boundedExpirationLedger,
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

  // #580: the exact-boundary case. signatureExpirationLedger is a Stellar
  // protocol field evaluated as "valid THROUGH this ledger, inclusive" — a
  // signature is only expired once the CURRENT ledger is STRICTLY GREATER
  // than signatureExpirationLedger (core's auth check is `ledger >
  // expiration`, not `>=`). boundedExpirationLedger sets that field to
  // anchor + MAX_EXPIRATION_LEDGERS, so the ledger exactly at the boundary —
  // the one the request was anchored from, plus the cap — must still be
  // INSIDE the authorized window, not past it. This pins that deliberate
  // choice rather than leaving it an accident of the `+`/comparison used.
  it("the boundary ledger (anchor + cap) is the last ledger still inside the window, not past it", () => {
    const anchor = 1_000;
    const expiration = boundedExpirationLedger(anchor);

    // One ledger before the boundary: unambiguously inside the window.
    expect(expiration - 1).toBeLessThan(expiration);
    // Exactly at the boundary: still the authorized expiration ledger itself
    // (inclusive) — the signature is valid for a request evaluated here.
    expect(expiration).toBe(anchor + MAX_EXPIRATION_LEDGERS);
    // One ledger after the boundary: unambiguously outside the window — this
    // is the first ledger at which the signature is expired.
    expect(expiration + 1).toBeGreaterThan(expiration);
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

// #817: a policy update can EXTEND the device signer's on-chain expiry while an
// approval that already checked the old expiry is still in flight. The
// approval's signature-expiration ledger is computed once, from the trusted
// anchor at check time, and boundedExpirationLedger takes nothing else as
// input — so a later extension can neither invalidate nor re-shape it. The
// end-to-end in-flight sequencing is covered in tx-signer.test.ts.
describe("signer expiry extended while an approval is in flight (#817)", () => {
  const SEVEN_DAYS_LEDGERS = (7 * 24 * 60 * 60) / 5;

  it("happy path: the expiration captured at check time is reproducible from the same anchor", () => {
    const anchor = 5_000;
    const captured = boundedExpirationLedger(anchor);
    // Recomputing after the extension, from the SAME anchor, yields the same
    // value: there is no hidden signer-expiry state that could change it.
    expect(boundedExpirationLedger(anchor)).toBe(captured);
    expect(captured).toBe(anchor + MAX_EXPIRATION_LEDGERS);
  });

  it("an extended signer expiry does not widen or shrink the in-flight window", () => {
    const anchor = 5_000;
    const oldSignerExpiry = anchor + 100;
    const captured = boundedExpirationLedger(anchor);
    // The approval passed its check against the OLD expiry.
    expect(captured).toBeLessThanOrEqual(oldSignerExpiry);

    const extendedSignerExpiry = oldSignerExpiry + SEVEN_DAYS_LEDGERS;
    // After the extension the captured window is still exactly the cap —
    // the extra signer lifetime is NOT folded into this approval's window...
    expect(captured - anchor).toBe(MAX_EXPIRATION_LEDGERS);
    // ...and it is still covered by the (now later) signer expiry, so nothing
    // about the extension can make the in-flight approval invalid.
    expect(captured).toBeLessThan(extendedSignerExpiry);
  });

  it("only a NEW anchor (the next approval) moves the window, never the extension itself", () => {
    const anchor = 5_000;
    const captured = boundedExpirationLedger(anchor);
    // The chain moved on while the extension landed; the NEXT approval anchors
    // there, with the same fixed cap. The in-flight one keeps its own value.
    const laterAnchor = anchor + 7;
    const next = boundedExpirationLedger(laterAnchor);
    expect(next - laterAnchor).toBe(MAX_EXPIRATION_LEDGERS);
    expect(next).not.toBe(captured);
    expect(boundedExpirationLedger(anchor)).toBe(captured);
  });

  it("still rejects a malformed anchor regardless of any signer-expiry change", () => {
    // Key failure mode: an extension is not a reason to accept an anchor the
    // trusted RPC returned in a bad shape.
    expect(() => boundedExpirationLedger(Number.NaN)).toThrow(/non-integer ledger anchor/);
    expect(() => boundedExpirationLedger(-SEVEN_DAYS_LEDGERS)).toThrow(/non-integer ledger anchor/);
  });
});
