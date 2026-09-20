import { describe, expect, it, vi } from "vitest";
import { startNonceSweeper } from "./nonce-sweeper";
import { createMemoryNonceRepository } from "./repository";

describe("startNonceSweeper", () => {
  it("sweeps expired nonces on start and leaves live ones alone", async () => {
    const nonces = createMemoryNonceRepository();
    const now = new Date("2026-03-01T12:00:00.000Z");
    await nonces.insert({
      nonce: "expired",
      address: "GA",
      createdAt: "2026-03-01T11:00:00.000Z",
      usedAt: null,
      expiresAt: "2026-03-01T11:05:00.000Z",
    });
    await nonces.insert({
      nonce: "live",
      address: "GA",
      createdAt: now.toISOString(),
      usedAt: null,
      expiresAt: "2026-03-01T12:05:00.000Z",
    });

    const stop = startNonceSweeper({ nonces, intervalMs: 60_000, now: () => now });
    await vi.waitFor(async () => {
      expect(await nonces.consume("live", "GA", now)).toBe(true);
    });
    // The expired row is gone; the live one was consumable above.
    expect(await nonces.consume("expired", "GA", now)).toBe(false);
    stop();
  });

  it("survives a failing sweep and keeps the service alive", async () => {
    const failing = {
      ...createMemoryNonceRepository(),
      deleteExpired: vi.fn().mockRejectedValue(new Error("postgres down")),
    };
    const warn = vi.fn();
    const stop = startNonceSweeper({
      nonces: failing,
      intervalMs: 60_000,
      log: { info: vi.fn(), warn },
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0]?.[1]).toContain("nonce sweep failed");
    stop();
  });

  it("stops sweeping once stopped", async () => {
    const nonces = createMemoryNonceRepository();
    const deleteExpired = vi.spyOn(nonces, "deleteExpired");
    const stop = startNonceSweeper({ nonces, intervalMs: 5 });
    await vi.waitFor(() => expect(deleteExpired).toHaveBeenCalled());
    stop();
    const callsAtStop = deleteExpired.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(deleteExpired.mock.calls.length).toBe(callsAtStop);
  });
});
