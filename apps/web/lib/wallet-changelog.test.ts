import { describe, expect, it } from "vitest";
import {
  getWalletChangelogEntry,
  normalizeChangelogHash,
  walletChangelog,
} from "./wallet-changelog";

const PINNED = "fdefad64b96837147e1c333e51f537b696eab925e9f147e63d597c04e3c903f0";

describe("wallet changelog", () => {
  it("returns the entry for the pinned wasm hash (happy path)", () => {
    const entry = getWalletChangelogEntry(PINNED);
    expect(entry).toBeDefined();
    expect(entry!.version).toBe("v1");
    expect(entry!.summary.length).toBeGreaterThan(0);
  });

  it("is case- and 0x-prefix tolerant on the hash", () => {
    expect(getWalletChangelogEntry(`0x${PINNED.toUpperCase()}`)).toBe(
      getWalletChangelogEntry(PINNED),
    );
  });

  it("returns undefined (not a broken entry) for an unknown hash", () => {
    expect(getWalletChangelogEntry("ab".repeat(32))).toBeUndefined();
    expect(getWalletChangelogEntry("")).toBeUndefined();
  });

  it("every entry carries a full 64-char hex hash and a summary", () => {
    for (const entry of walletChangelog) {
      expect(normalizeChangelogHash(entry.wasmHash)).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.summary.trim().length).toBeGreaterThan(0);
      expect(entry.version.trim().length).toBeGreaterThan(0);
    }
  });
});
