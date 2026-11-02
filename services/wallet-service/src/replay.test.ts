import { describe, expect, it } from "vitest";
import {
  createMemoryReplayGuard,
  DEFAULT_MAX_AUTH_EXPIRATION_LEDGERS,
  extractReplayKeys,
  maxAuthExpirationLedgersFromEnv,
  RELEASABLE_SUBMISSION_CODES,
  replayFingerprint,
} from "./replay";
import { buildInvokeTx, KNOWN_WALLET, OTHER_CONTRACT, PASSPHRASE } from "./test-fixtures";

// Replay protection for the sponsor-submission path (technical-doc §8, idea.md
// §12; approved design 1A). Identity = (server-config network, credential
// address, nonce) per auth entry: the sponsor REBUILDS the envelope, so anything
// derived from the envelope (hash, source, sequence, fee) is re-wrappable.

describe("extractReplayKeys", () => {
  it("keys each address-credential entry on (address, nonce) with its expiration ledger", () => {
    const xdrStr = buildInvokeTx([
      { subject: KNOWN_WALLET, nonce: "111", expiration: 5000 },
      { subject: OTHER_CONTRACT, nonce: "222", expiration: 5010 },
    ]);

    expect(extractReplayKeys(xdrStr, PASSPHRASE)).toEqual([
      { address: KNOWN_WALLET, nonce: "111", signatureExpirationLedger: 5000 },
      { address: OTHER_CONTRACT, nonce: "222", signatureExpirationLedger: 5010 },
    ]);
  });

  it("is independent of the envelope: a re-wrapped tx (new source, sequence, fee) has the same keys", () => {
    // buildInvokeTx draws a fresh random source account per call, so these two
    // envelopes differ in source and therefore in tx hash, with identical auth.
    const a = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "42", expiration: 900 }]);
    const b = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "42", expiration: 900 }]);

    expect(a).not.toBe(b);
    expect(extractReplayKeys(a, PASSPHRASE)).toEqual(extractReplayKeys(b, PASSPHRASE));
  });

  it.each(["v1", "v2", "delegates"] as const)(
    "reads nonce and expiration from a %s address-bound credential",
    (kind) => {
      const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, kind, nonce: "7", expiration: 321 }]);
      expect(extractReplayKeys(xdrStr, PASSPHRASE)).toEqual([
        { address: KNOWN_WALLET, nonce: "7", signatureExpirationLedger: 321 },
      ]);
    },
  );

  it("keeps the nonce exact for values beyond 2^53 (int64 as a decimal string)", () => {
    const big = "9223372036854775807";
    const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: big, expiration: 1 }]);
    expect(extractReplayKeys(xdrStr, PASSPHRASE)[0]?.nonce).toBe(big);
  });

  it("keeps a negative int64 nonce distinct from its positive twin", () => {
    const neg = extractReplayKeys(
      buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "-5", expiration: 1 }]),
      PASSPHRASE,
    );
    const pos = extractReplayKeys(
      buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "5", expiration: 1 }]),
      PASSPHRASE,
    );
    expect(neg[0]?.nonce).toBe("-5");
    expect(neg[0]?.nonce).not.toBe(pos[0]?.nonce);
  });

  it("de-duplicates a repeated (address, nonce) within one tx", () => {
    const xdrStr = buildInvokeTx([
      { subject: KNOWN_WALLET, nonce: "9", expiration: 100 },
      { subject: KNOWN_WALLET, nonce: "9", expiration: 100 },
    ]);
    expect(extractReplayKeys(xdrStr, PASSPHRASE)).toHaveLength(1);
  });

  it("treats the same nonce under two different addresses as two keys", () => {
    const xdrStr = buildInvokeTx([
      { subject: KNOWN_WALLET, nonce: "9", expiration: 100 },
      { subject: OTHER_CONTRACT, nonce: "9", expiration: 100 },
    ]);
    expect(extractReplayKeys(xdrStr, PASSPHRASE)).toHaveLength(2);
  });

  it("returns [] for junk or a tx with no address credentials", () => {
    expect(extractReplayKeys("not-an-xdr", PASSPHRASE)).toEqual([]);
    expect(extractReplayKeys("", PASSPHRASE)).toEqual([]);
    expect(
      extractReplayKeys(buildInvokeTx([{ subject: KNOWN_WALLET, kind: "source" }]), PASSPHRASE),
    ).toEqual([]);
  });

  it("does not depend on the network passphrase: the keys are the same under either", () => {
    // Identity comes from the signed auth entries. The passphrase only affects
    // hashing, so a caller cannot change the keys by relabelling the network.
    const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "3", expiration: 50 }]);
    expect(extractReplayKeys(xdrStr, "Public Global Stellar Network ; September 2015")).toEqual(
      extractReplayKeys(xdrStr, PASSPHRASE),
    );
  });
});

describe("replayFingerprint", () => {
  it("is order-independent and does not embed the raw nonce or address", () => {
    const k1 = { address: KNOWN_WALLET, nonce: "123456789", signatureExpirationLedger: 1 };
    const k2 = { address: OTHER_CONTRACT, nonce: "987654321", signatureExpirationLedger: 2 };
    const fp = replayFingerprint([k1, k2]);

    expect(fp).toBe(replayFingerprint([k2, k1]));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain("123456789");
    expect(fp).not.toContain(KNOWN_WALLET.slice(0, 8));
  });

  it("differs for a different key set", () => {
    const a = { address: KNOWN_WALLET, nonce: "1", signatureExpirationLedger: 1 };
    const b = { address: KNOWN_WALLET, nonce: "2", signatureExpirationLedger: 1 };
    expect(replayFingerprint([a])).not.toBe(replayFingerprint([b]));
  });
});

describe("createMemoryReplayGuard", () => {
  const key = (nonce: string, expiration = 1000) => ({
    address: KNOWN_WALLET,
    nonce,
    signatureExpirationLedger: expiration,
  });

  it("reserves a fresh set, then refuses the same set", async () => {
    const guard = createMemoryReplayGuard();
    expect(await guard.reserve([key("1"), key("2")])).toEqual({ ok: true });
    expect(await guard.reserve([key("1"), key("2")])).toEqual({ ok: false, reason: "replay" });
  });

  it("is ALL-OR-NOTHING: a set sharing any reserved key reserves none of its keys", async () => {
    const guard = createMemoryReplayGuard();
    await guard.reserve([key("A")]);

    // [B, A]: A is already reserved. B must NOT be left reserved, or the
    // legitimate signer of B could never submit it (partial-replay lockout).
    expect(await guard.reserve([key("B"), key("A")])).toEqual({ ok: false, reason: "replay" });
    expect(await guard.reserve([key("B")])).toEqual({ ok: true });
  });

  it("an empty key set reserves nothing and succeeds", async () => {
    const guard = createMemoryReplayGuard();
    expect(await guard.reserve([])).toEqual({ ok: true });
  });

  it("release frees exactly the given keys", async () => {
    const guard = createMemoryReplayGuard();
    await guard.reserve([key("1"), key("2")]);

    await guard.release([key("1")]);

    expect(await guard.reserve([key("1")])).toEqual({ ok: true });
    expect(await guard.reserve([key("2")])).toEqual({ ok: false, reason: "replay" });
  });

  it("release of a never-reserved key is a no-op", async () => {
    const guard = createMemoryReplayGuard();
    await expect(guard.release([key("nope")])).resolves.toBeUndefined();
  });

  it("two concurrent identical reservations: exactly one wins", async () => {
    const guard = createMemoryReplayGuard();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => guard.reserve([key("race")])),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(7);
  });

  it("purgeExpired drops reservations strictly below the current ledger and keeps the rest", async () => {
    const guard = createMemoryReplayGuard();
    await guard.reserve([key("old", 99), key("edge", 100), key("live", 101)]);

    await guard.purgeExpired(100);

    // 99 < 100: gone (the host would reject the expired entry at simulation).
    expect(await guard.reserve([key("old", 99)])).toEqual({ ok: true });
    // 100 is not strictly below 100: still reserved, as is 101.
    expect(await guard.reserve([key("edge", 100)])).toEqual({ ok: false, reason: "replay" });
    expect(await guard.reserve([key("live", 101)])).toEqual({ ok: false, reason: "replay" });
  });
});

describe("RELEASABLE_SUBMISSION_CODES", () => {
  it.each([
    "relayer_not_configured",
    "sponsor_bad_tx",
    "sponsor_simulation_failed",
    "sponsor_fee_too_high",
    "sponsor_budget_exceeded",
    "sponsor_try_again_later",
    "sponsor_submit_failed",
  ])("%s provably happened before the tx could land, so it is releasable", (code) => {
    expect(RELEASABLE_SUBMISSION_CODES.has(code)).toBe(true);
  });

  it.each(["tx_timeout", "tx_failed", "submission_failed", "txBadSeq", "Simulation failed", ""])(
    "%s may have landed or is unknown, so it is NOT releasable",
    (code) => {
      expect(RELEASABLE_SUBMISSION_CODES.has(code)).toBe(false);
    },
  );
});

describe("maxAuthExpirationLedgersFromEnv", () => {
  it("defaults to 120 ledgers (~10 minutes) when unset or blank", () => {
    expect(DEFAULT_MAX_AUTH_EXPIRATION_LEDGERS).toBe(120);
    expect(maxAuthExpirationLedgersFromEnv(undefined)).toBe(120);
    expect(maxAuthExpirationLedgersFromEnv("")).toBe(120);
    expect(maxAuthExpirationLedgersFromEnv("   ")).toBe(120);
  });

  it.each([
    ["1", 1],
    ["60", 60],
    ["120", 120],
    [" 720 ", 720],
  ])("accepts the positive integer %j", (raw, expected) => {
    expect(maxAuthExpirationLedgersFromEnv(raw)).toBe(expected);
  });

  // A typo must fail the boot loudly: silently falling back to the default would
  // hide a misconfiguration, and silently accepting garbage could disable the cap.
  it.each(["0", "-5", "1.5", "abc", "12abc", "1e3", "NaN", "Infinity", "0x10", "9007199254740993"])(
    "rejects %j rather than guessing",
    (raw) => {
      expect(() => maxAuthExpirationLedgersFromEnv(raw)).toThrow(/MAX_AUTH_EXPIRATION_LEDGERS/);
    },
  );
});
