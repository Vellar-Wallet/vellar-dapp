import { describe, it, expect, vi, beforeEach } from "vitest";

// The loop is mocked so this suite tests the generic group mechanics in
// isolation, without real timers or a verification pipeline.
vi.mock("./loop", () => ({
  startWorkerLoop: vi.fn(() => ({
    stop: vi.fn(),
    drain: vi.fn(async () => true),
    getInFlightCount: vi.fn(() => 0),
  })),
}));

import { startWorkerLoop, type WorkerDeps } from "./loop";
import { startConsumerGroup } from "./consumer-group";

function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store: { claimSubmitted: vi.fn() },
    ...overrides,
  } as unknown as WorkerDeps;
}

describe("consumer-group.ts — generic primitive (issue #795)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts one worker loop per concurrency setting and returns the domain label", () => {
    const group = startConsumerGroup({
      domain: "transaction",
      concurrency: 3,
      workerDeps: makeDeps(),
    });

    expect(startWorkerLoop).toHaveBeenCalledTimes(3);
    expect(group.domain).toBe("transaction");
  });

  it("defaults to a single loop when concurrency is omitted", () => {
    const group = startConsumerGroup({
      domain: "verification",
      workerDeps: makeDeps(),
    });

    expect(startWorkerLoop).toHaveBeenCalledTimes(1);
    expect(group.domain).toBe("verification");
  });

  it("tags each loop's log with the domain and instance index", () => {
    const info = vi.fn();
    const error = vi.fn();

    startConsumerGroup({
      domain: "transaction",
      concurrency: 2,
      workerDeps: makeDeps({ log: { info, error } }),
    });

    const calls = vi.mocked(startWorkerLoop).mock.calls;
    calls[0]![0].log!.info("tick");
    calls[1]![0].log!.info("tick");
    calls[0]![0].log!.error("boom", new Error("x"));

    expect(info).toHaveBeenNthCalledWith(1, "[transaction#0] tick");
    expect(info).toHaveBeenNthCalledWith(2, "[transaction#1] tick");
    expect(error).toHaveBeenCalledWith("[transaction#0] boom", expect.any(Error));
  });

  it("uses a plain domain tag when there is only one loop", () => {
    const info = vi.fn();

    startConsumerGroup({
      domain: "verification",
      workerDeps: makeDeps({ log: { info, error: vi.fn() } }),
    });

    vi.mocked(startWorkerLoop).mock.calls[0]![0].log!.info("tick");
    expect(info).toHaveBeenCalledWith("[verification] tick");
  });

  it("stop() stops every loop the group started", () => {
    const group = startConsumerGroup({
      domain: "transaction",
      concurrency: 3,
      workerDeps: makeDeps(),
    });
    const handles = vi.mocked(startWorkerLoop).mock.results.map((result) => result.value);

    group.stop();

    expect(handles).toHaveLength(3);
    for (const handle of handles) {
      expect(handle.stop).toHaveBeenCalledTimes(1);
    }
  });

  it("is reusable outside verification (no verification-only dependencies)", () => {
    // The generic primitive accepts arbitrary deps and a caller-chosen label.
    // Verification wiring belongs exclusively to ./consumer-groups.ts.
    const genericDeps = {
      store: { claimSubmitted: vi.fn() },
      marker: "any-domain",
    } as unknown as WorkerDeps;

    const group = startConsumerGroup({ domain: "billing", workerDeps: genericDeps });

    expect(group.domain).toBe("billing");
    expect(vi.mocked(startWorkerLoop).mock.calls[0]![0]).toMatchObject({ marker: "any-domain" });
  });
});
