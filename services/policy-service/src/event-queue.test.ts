import { describe, expect, it, vi } from "vitest";
import { __resetMetricsForTest, metricsRegistry } from "@vellar/service-kit";
import { PolicyEventQueue } from "./event-queue";

describe("PolicyEventQueue — Poison-message detection & quarantine (Issue #297)", () => {
  it("processes valid messages successfully without quarantine", async () => {
    const queue = new PolicyEventQueue({ maxAttempts: 3 });
    await queue.enqueue({
      eventType: "policy.created",
      payload: { policyId: "pol-123" },
    });

    const handler = vi.fn(async () => {});
    const result = await queue.processNext(handler);

    expect(result?.outcome).toBe("success");
    expect(result?.attempts).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount()).toBe(0);
    expect(await queue.getQuarantine().count()).toBe(0);
  });

  it("detects repeatedly failing malformed message and moves to quarantine queue after maxAttempts", async () => {
    __resetMetricsForTest();

    const loggedErrors: string[] = [];
    const alertCallbacks: unknown[] = [];

    const queue = new PolicyEventQueue({
      maxAttempts: 3,
      log: {
        info: () => {},
        warn: () => {},
        error: (msg) => loggedErrors.push(msg),
      },
      onQuarantine: (item) => alertCallbacks.push(item),
    });

    // Enqueue a malformed event that always crashes the handler
    const malformedMsg = await queue.enqueue({
      id: "poison-event-999",
      eventType: "policy.corrupted",
      payload: { malformedSyntax: true },
    });

    const failingHandler = vi.fn(async () => {
      throw new Error("SyntaxError: Unexpected token in JSON at position 42");
    });

    // Attempt 1: fails, re-queued
    const res1 = await queue.processNext(failingHandler);
    expect(res1?.outcome).toBe("retry");
    expect(res1?.attempts).toBe(1);
    expect(await queue.getQuarantine().count()).toBe(0);

    // Attempt 2: fails, re-queued
    const res2 = await queue.processNext(failingHandler);
    expect(res2?.outcome).toBe("retry");
    expect(res2?.attempts).toBe(2);
    expect(await queue.getQuarantine().count()).toBe(0);

    // Attempt 3: fails, exceeds maxAttempts -> QUARANTINED
    const res3 = await queue.processNext(failingHandler);
    expect(res3?.outcome).toBe("quarantined");
    expect(res3?.attempts).toBe(3);
    expect(res3?.reason).toContain("SyntaxError");

    // Verify message was moved to quarantine queue
    const quarantine = queue.getQuarantine();
    expect(await quarantine.count()).toBe(1);
    const quarantined = await quarantine.get("poison-event-999");
    expect(quarantined).toBeDefined();
    expect(quarantined?.message.id).toBe("poison-event-999");
    expect(quarantined?.attempts).toBe(3);
    expect(quarantined?.reason).toContain("SyntaxError");

    // Verify Alert 1: Alert log was emitted with [ALERT] tag
    const alertLog = loggedErrors.find((l) => l.includes("[ALERT] Poison message quarantined"));
    expect(alertLog).toBeDefined();
    expect(alertLog).toContain("id=poison-event-999");

    // Verify Alert 2: Prometheus counter incremented
    const metricsText = await metricsRegistry().metrics();
    expect(metricsText).toContain("vela_policy_poison_messages_total");
    expect(metricsText).toMatch(
      /vela_policy_poison_messages_total\{[^}]*service="policy-service"[^}]*outcome="failure"[^}]*\}\s+1/,
    );

    // Verify Alert 3: onQuarantine callback was invoked
    expect(alertCallbacks).toHaveLength(1);
    expect((alertCallbacks[0] as { message: { id: string } }).message.id).toBe("poison-event-999");

    // Queue is now empty (poison message isolated)
    expect(queue.pendingCount()).toBe(0);
  });

  it("consumer does not crash on malformed event and continues processing subsequent valid messages", async () => {
    const queue = new PolicyEventQueue({ maxAttempts: 2 });

    // Enqueue 1: malformed message
    await queue.enqueue({
      id: "bad-msg",
      eventType: "policy.malformed",
      payload: { crash: true },
    });

    // Enqueue 2: valid message
    await queue.enqueue({
      id: "good-msg",
      eventType: "policy.valid",
      payload: { valid: true },
    });

    const handler = vi.fn(async (msg) => {
      if (msg.id === "bad-msg") {
        throw new Error("Fatal payload parse error");
      }
    });

    const results = await queue.processAll(handler);

    // bad-msg failed attempt 1, re-queued; good-msg succeeded; bad-msg failed attempt 2 -> quarantined
    const goodResult = results.find((r) => r.messageId === "good-msg");
    const badResult = results.find((r) => r.messageId === "bad-msg" && r.outcome === "quarantined");

    expect(goodResult?.outcome).toBe("success");
    expect(badResult?.outcome).toBe("quarantined");
    expect(await queue.getQuarantine().count()).toBe(1);
  });

  describe("backlog-depth metrics exposed on /metrics (#524)", () => {
    it("reports metric reading zero when queue is empty", async () => {
      __resetMetricsForTest();
      // Initialize an empty queue
      new PolicyEventQueue();

      const metricsText = await metricsRegistry().metrics();
      expect(metricsText).toContain("vela_policy_event_queue_depth");
      expect(metricsText).toMatch(
        /vela_policy_event_queue_depth\{[^}]*service="policy-service"[^}]*\}\s+0/,
      );
    });

    it("tracks backlog depth accurately as items are enqueued and processed", async () => {
      __resetMetricsForTest();
      const queue = new PolicyEventQueue();

      // Enqueue 2 items
      await queue.enqueue({ eventType: "policy.one", payload: { id: "1" } });
      await queue.enqueue({ eventType: "policy.two", payload: { id: "2" } });

      let metricsText = await metricsRegistry().metrics();
      expect(metricsText).toMatch(
        /vela_policy_event_queue_depth\{[^}]*service="policy-service"[^}]*\}\s+2/,
      );

      // Process 1 item successfully
      await queue.processNext(async () => {});
      metricsText = await metricsRegistry().metrics();
      expect(metricsText).toMatch(
        /vela_policy_event_queue_depth\{[^}]*service="policy-service"[^}]*\}\s+1/,
      );

      // Process the second item
      await queue.processNext(async () => {});
      metricsText = await metricsRegistry().metrics();
      expect(metricsText).toMatch(
        /vela_policy_event_queue_depth\{[^}]*service="policy-service"[^}]*\}\s+0/,
      );
    });

    it("keeps the metric consistent when an event is enqueued mid-scrape (#793)", async () => {
      const observed: Array<{ reported: number; live: number }> = [];
      let consumer: PolicyEventQueue<{ seq: number }> | undefined;
      let reentrantEnqueueDone = false;

      const queueDepthGauge = {
        set: (labels: { service: string }, value: number) => {
          expect(labels.service).toBe("policy-service");
          // A scrape reading the gauge at this instant must see the same depth
          // as the live queue. During construction the consumer is not yet
          // assigned, and the initial depth is 0.
          observed.push({ reported: value, live: consumer?.pendingCount() ?? 0 });

          // Simulate a second event landing while the first enqueue's metric
          // write is being observed. enqueue() has no async gap, so the
          // re-entrant call completes before the outer one returns.
          if (!reentrantEnqueueDone && value === 1) {
            reentrantEnqueueDone = true;
            void consumer!.enqueue({ eventType: "policy.mid-read", payload: { seq: 2 } });
          }
        },
      };

      consumer = new PolicyEventQueue<{ seq: number }>({ queueDepthGauge });
      await consumer.enqueue({ eventType: "policy.first", payload: { seq: 1 } });

      expect(reentrantEnqueueDone).toBe(true);
      expect(consumer.pendingCount()).toBe(2);
      // The final reading reflects the settled depth (2), never the stale
      // intermediate value captured when the first enqueue began.
      expect(observed.map((reading) => reading.reported)).toEqual([0, 1, 2]);
      for (const reading of observed) {
        expect(reading.reported).toBe(reading.live);
      }
    });

    it("keeps the metric consistent when a message is dequeued mid-scrape (#793)", async () => {
      const observed: Array<{ reported: number; live: number }> = [];
      let consumer: PolicyEventQueue<number> | undefined;

      const queueDepthGauge = {
        set: (_labels: { service: string }, value: number) => {
          observed.push({ reported: value, live: consumer?.pendingCount() ?? 0 });
        },
      };

      consumer = new PolicyEventQueue<number>({ queueDepthGauge });
      await consumer.enqueue({ eventType: "first", payload: 1 });
      await consumer.enqueue({ eventType: "second", payload: 2 });
      await consumer.processNext(async () => {});

      expect(observed.map((reading) => reading.reported)).toEqual([0, 1, 2, 1]);
      for (const reading of observed) {
        expect(reading.reported).toBe(reading.live);
      }
      expect(consumer.pendingCount()).toBe(1);
    });

    it("maintains accurate backlog depth when a message fails and is re-queued or quarantined", async () => {
      __resetMetricsForTest();
      const queue = new PolicyEventQueue({ maxAttempts: 2 });

      await queue.enqueue({ eventType: "policy.failing", payload: { fail: true } });

      let metricsText = await metricsRegistry().metrics();
      expect(metricsText).toMatch(
        /vela_policy_event_queue_depth\{[^}]*service="policy-service"[^}]*\}\s+1/,
      );

      // Attempt 1: fails and is re-queued -> backlog depth is still 1
      await queue.processNext(async () => {
        throw new Error("Temporary failure");
      });
      metricsText = await metricsRegistry().metrics();
      expect(metricsText).toMatch(
        /vela_policy_event_queue_depth\{[^}]*service="policy-service"[^}]*\}\s+1/,
      );

      // Attempt 2: fails again and is quarantined -> backlog depth becomes 0
      await queue.processNext(async () => {
        throw new Error("Temporary failure");
      });
      metricsText = await metricsRegistry().metrics();
      expect(metricsText).toMatch(
        /vela_policy_event_queue_depth\{[^}]*service="policy-service"[^}]*\}\s+0/,
      );
    });
  });
});

