import { describe, expect, it } from "vitest";
import { extractAddressAuthSubjects, ScopeError, assertScopedToKnownWallets } from "./scope";
import { buildInvokeTx, KNOWN_WALLET, OTHER_CONTRACT, PASSPHRASE } from "./test-fixtures";

describe("extractAddressAuthSubjects", () => {
  it("returns every address-credential subject in the tx (V2 — the real signer shape)", () => {
    const xdrStr = buildInvokeTx([KNOWN_WALLET, OTHER_CONTRACT]);
    const subjects = extractAddressAuthSubjects(xdrStr, PASSPHRASE);
    expect(subjects).toEqual([KNOWN_WALLET, OTHER_CONTRACT]);
  });

  // RA-1: passkey-kit@0.14 signs V2, not V1. Each address-bound variant must be
  // recognized, or the gate returns [] for real traffic (fail-closed break) and
  // skips attacker V2 legs in a mixed tx (scope evasion).
  it.each(["v1", "v2", "delegates"] as const)(
    "extracts the subject from a %s address-bound credential",
    (kind) => {
      const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, kind }]);
      expect(extractAddressAuthSubjects(xdrStr, PASSPHRASE)).toEqual([KNOWN_WALLET]);
    },
  );

  it("extracts BOTH subjects from a mixed V1 + V2 transaction (no leg skipped)", () => {
    // The RA-1 bypass: one V1 entry bound to a known wallet + one V2 entry bound
    // to an attacker contract. If V2 is skipped, the attacker leg rides past the
    // gate. Both subjects must surface.
    const xdrStr = buildInvokeTx([
      { subject: KNOWN_WALLET, kind: "v1" },
      { subject: OTHER_CONTRACT, kind: "v2" },
    ]);
    expect(extractAddressAuthSubjects(xdrStr, PASSPHRASE)).toEqual([KNOWN_WALLET, OTHER_CONTRACT]);
  });

  it("ignores source-account credentials (a deploy carries no address subject)", () => {
    const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, kind: "source" }]);
    expect(extractAddressAuthSubjects(xdrStr, PASSPHRASE)).toEqual([]);
  });

  it("returns [] for an unparseable xdr rather than throwing", () => {
    expect(extractAddressAuthSubjects("not-an-xdr", PASSPHRASE)).toEqual([]);
  });
});

describe("assertScopedToKnownWallets", () => {
  const knownOnly = async (contractId: string) => contractId === KNOWN_WALLET;

  it("passes when every address subject is a known wallet", async () => {
    const xdrStr = buildInvokeTx([KNOWN_WALLET]);
    await expect(
      assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly),
    ).resolves.toBeUndefined();
  });

  it("rejects when any address subject is NOT a known wallet (covers both submitter branches)", async () => {
    const xdrStr = buildInvokeTx([OTHER_CONTRACT]);
    await expect(assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly)).rejects.toBeInstanceOf(
      ScopeError,
    );
  });

  it("rejects a tx mixing a known wallet with an unknown contract", async () => {
    const xdrStr = buildInvokeTx([KNOWN_WALLET, OTHER_CONTRACT]);
    await expect(assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly)).rejects.toBeInstanceOf(
      ScopeError,
    );
  });

  it("rejects the RA-1 bypass: a known-wallet V1 leg + an attacker-contract V2 leg", async () => {
    // Both legs must be scoped. The V2 attacker leg must NOT ride past the gate.
    const xdrStr = buildInvokeTx([
      { subject: KNOWN_WALLET, kind: "v1" },
      { subject: OTHER_CONTRACT, kind: "v2" },
    ]);
    await expect(assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly)).rejects.toBeInstanceOf(
      ScopeError,
    );
  });

  it("passes a real V2-signed single-op wallet tx (must not fail-closed on legit traffic)", async () => {
    const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, kind: "v2" }]);
    await expect(
      assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly),
    ).resolves.toBeUndefined();
  });

  it("rejects a tx with NO address-credential subject at all (nothing to attribute the spend to)", async () => {
    // A source-account-auth invoke has no address subject; the relayer/sponsor
    // must not fund a tx we cannot attribute to a known wallet.
    const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, kind: "source" }]);
    await expect(assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly)).rejects.toBeInstanceOf(
      ScopeError,
    );
  });
});
