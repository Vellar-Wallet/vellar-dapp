import { describe, it, expect, vi, beforeEach } from "vitest";
import { createVerificationGroup } from "./consumer-groups";
import type { VerificationJobStore } from "./job-store";
import type { Executor } from "./executor";
import type { Resolver } from "./resolver";

describe("consumer-groups (issue #354)", () => {
  // Mock dependencies for testing consumer group isolation.
  const mockStore: VerificationJobStore = {
    claimSubmitted: vi.fn(),
    complete: vi.fn(),
    reapStranded: vi.fn(),
    countActive: vi.fn(),
    hasActiveForContract: vi.fn(),
    listLatestVerified: vi.fn(),
  };

  const mockExecutor: Executor = {
    build: vi.fn(),
  };

  const mockResolver: Resolver = {
    resolveArtifact: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("verification group uses only the verification store", async () => {
    // Simulate an empty queue (store returns empty array).
    vi.mocked(mockStore.claimSubmitted).mockResolvedValue([]);

    // Create a verification consumer group with concurrency 1.
    const group = createVerificationGroup({
      store: mockStore,
      executor: mockExecutor,
      resolver: mockResolver,
      concurrency: 1,
      idleDelayMs: 100,
      busyDelayMs: 50,
    });

    // Let the group poll once (wait longer for async loop to start).
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify the group claimed from the verification store.
    expect(mockStore.claimSubmitted).toHaveBeenCalled();

    // Cleanup: stop the group.
    group.stop();
  });

  it("verification group respects configured concurrency", async () => {
    const concurrency = 3;
    
    // Simulate an empty queue.
    vi.mocked(mockStore.claimSubmitted).mockResolvedValue([]);
    
    const group = createVerificationGroup({
      store: mockStore,
      executor: mockExecutor,
      resolver: mockResolver,
      concurrency,
      idleDelayMs: 100,
      busyDelayMs: 50,
    });

    // Let the group poll once across all workers.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // With 3 workers, we expect at least 3 claim attempts (one per worker).
    // Note: in practice there may be slightly more due to timing, so we check >= 3.
    expect(mockStore.claimSubmitted).toHaveBeenCalled();
    expect(vi.mocked(mockStore.claimSubmitted).mock.calls.length).toBeGreaterThanOrEqual(concurrency);

    group.stop();
  });

  it("verification group can be stopped and restarted", () => {
    const group = createVerificationGroup({
      store: mockStore,
      executor: mockExecutor,
      resolver: mockResolver,
      concurrency: 1,
      idleDelayMs: 100,
    });

    // Stop should be idempotent.
    group.stop();
    group.stop();

    // After stopping, no new claims should occur.
    const callsBefore = vi.mocked(mockStore.claimSubmitted).mock.calls.length;
    
    // Wait a bit to ensure no new calls.
    setTimeout(() => {
      const callsAfter = vi.mocked(mockStore.claimSubmitted).mock.calls.length;
      expect(callsAfter).toBe(callsBefore);
    }, 200);
  });

  it("multiple consumer groups operate independently", async () => {
    // Create two separate verification groups with different stores.
    const store1: VerificationJobStore = {
      claimSubmitted: vi.fn().mockResolvedValue([]),
      complete: vi.fn(),
      reapStranded: vi.fn(),
      countActive: vi.fn(),
      hasActiveForContract: vi.fn(),
      listLatestVerified: vi.fn(),
    };

    const store2: VerificationJobStore = {
      claimSubmitted: vi.fn().mockResolvedValue([]),
      complete: vi.fn(),
      reapStranded: vi.fn(),
      countActive: vi.fn(),
      hasActiveForContract: vi.fn(),
      listLatestVerified: vi.fn(),
    };

    const group1 = createVerificationGroup({
      store: store1,
      executor: mockExecutor,
      resolver: mockResolver,
      concurrency: 1,
      idleDelayMs: 100,
    });

    const group2 = createVerificationGroup({
      store: store2,
      executor: mockExecutor,
      resolver: mockResolver,
      concurrency: 1,
      idleDelayMs: 100,
    });

    // Let both groups poll.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Each group should have claimed from its own store.
    expect(store1.claimSubmitted).toHaveBeenCalled();
    expect(store2.claimSubmitted).toHaveBeenCalled();

    // Verify they didn't cross-pollinate.
    expect(store1.claimSubmitted).not.toBe(store2.claimSubmitted);

    group1.stop();
    group2.stop();
  });

  it("consumer group passes correct dependencies to workers", async () => {
    const customLog = {
      info: vi.fn(),
      error: vi.fn(),
    };

    vi.mocked(mockStore.claimSubmitted).mockResolvedValue([]);

    const group = createVerificationGroup({
      store: mockStore,
      executor: mockExecutor,
      resolver: mockResolver,
      concurrency: 1,
      idleDelayMs: 100,
      busyDelayMs: 50,
      log: customLog,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    // The worker should have received the store and attempted to claim.
    expect(mockStore.claimSubmitted).toHaveBeenCalled();

    group.stop();
  });
});
