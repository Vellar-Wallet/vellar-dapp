// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { mergeFetchedHistoryPages } from "./history";
import type { HistoryTx } from "./history-types";

function row(id: string, timestamp: string, amount = 1n): HistoryTx {
  return {
    id,
    kind: "soroban",
    direction: "in",
    counterparty: "GOTHER",
    amount,
    asset: { kind: "soroban", code: "USDC", decimals: 7, contractId: "CCONTRACT" },
    timestamp,
    status: "success",
    txHash: "aa".repeat(32),
  };
}

describe("mergeFetchedHistoryPages (#779)", () => {
  it("merges two overlapping pages fetched in quick succession without duplicating rows", async () => {
    const shared = row("soroban:1", "2026-09-28T03:13:02Z", 10n);
    const pageA = {
      rows: [shared, row("soroban:2", "2026-09-28T03:13:01Z", 20n)],
      nextCursor: "cursor-a",
    };
    const pageB = {
      rows: [shared, row("soroban:3", "2026-09-28T03:13:00Z", 30n)],
      nextCursor: "cursor-b",
    };

    // Simulate a double-load race: both requests resolve and are merged in arrival order.
    const [a, b] = await Promise.all([Promise.resolve(pageA), Promise.resolve(pageB)]);
    const merged = mergeFetchedHistoryPages([a, b]);

    expect(merged.map((r) => r.id)).toEqual(["soroban:1", "soroban:2", "soroban:3"]);
    expect(new Set(merged.map((r) => r.id)).size).toBe(merged.length);
  });

  it("preserves first-seen row and does not drop non-overlapping rows when pages arrive out of order", async () => {
    const shared = row("soroban:shared", "2026-09-28T03:13:02Z", 10n);
    const older = row("soroban:older", "2026-09-27T03:13:02Z", 5n);
    const newer = row("soroban:newer", "2026-09-29T03:13:02Z", 15n);

    const slowOlderPage = new Promise<{ rows: HistoryTx[]; nextCursor?: string }>((resolve) =>
      setTimeout(() => resolve({ rows: [shared, older], nextCursor: "older" }), 5),
    );
    const fastNewerPage = Promise.resolve({ rows: [newer, shared], nextCursor: "newer" });

    const merged = mergeFetchedHistoryPages(await Promise.all([fastNewerPage, slowOlderPage]));

    expect(merged.map((r) => r.id)).toEqual(["soroban:newer", "soroban:shared", "soroban:older"]);
    expect(merged.filter((r) => r.id === "soroban:shared")).toHaveLength(1);
  });

  it("handles an empty overlap and keeps ordering stable within merged pages", () => {
    const p1 = { rows: [row("a", "2026-01-03T00:00:00Z"), row("b", "2026-01-02T00:00:00Z")] };
    const p2 = { rows: [row("c", "2026-01-01T00:00:00Z")] };
    expect(mergeFetchedHistoryPages([p1, p2]).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
