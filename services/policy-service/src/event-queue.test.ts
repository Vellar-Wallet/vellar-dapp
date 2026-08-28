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
});
