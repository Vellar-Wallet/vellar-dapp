import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildServer } from "./server";
import {
  createProxyCircuitBreakerHooks,
  registerVersionedProxyRoute,
} from "./register-proxy-route";

async function reserveUnusedPort(): Promise<number> {
  const probe = Fastify();
  await probe.listen({ port: 0, host: "127.0.0.1" });
  const { port } = probe.server.address() as AddressInfo;
  await probe.close();
  return port;
}

describe("register-proxy-route — independent per-upstream circuit breakers (#546)", () => {
  it("trips the breaker for policy-service while wallet-service, lifecycle-service, and verification-service continue serving normally, then recovers via half-open trial", async () => {
    const walletUpstream = Fastify();
    walletUpstream.get("/wallet/status", async () => ({ service: "wallet-service", status: "ok" }));
    await walletUpstream.listen({ port: 0, host: "127.0.0.1" });
    const { port: walletPort } = walletUpstream.server.address() as AddressInfo;

    const lifecycleUpstream = Fastify();
    lifecycleUpstream.get("/lifecycle/status", async () => ({
      service: "lifecycle-service",
      status: "ok",
    }));
    await lifecycleUpstream.listen({ port: 0, host: "127.0.0.1" });
    const { port: lifecyclePort } = lifecycleUpstream.server.address() as AddressInfo;

    const verificationUpstream = Fastify();
    verificationUpstream.get("/verification/status", async () => ({
      service: "verification-service",
      status: "ok",
    }));
    await verificationUpstream.listen({ port: 0, host: "127.0.0.1" });
    const { port: verificationPort } = verificationUpstream.server.address() as AddressInfo;

    // Reserve a closed port for policy-service so it initially fails with ECONNREFUSED
    const policyPort = await reserveUnusedPort();
    const policyUpstream = Fastify();
    policyUpstream.get("/policies/list", async () => ({
      service: "policy-service",
      policies: ["spending_limit"],
    }));

    const app = buildServer({
      walletServiceUrl: `http://127.0.0.1:${walletPort}`,
      lifecycleServiceUrl: `http://127.0.0.1:${lifecyclePort}`,
      policyServiceUrl: `http://127.0.0.1:${policyPort}`,
      verificationServiceUrl: `http://127.0.0.1:${verificationPort}`,
      policyCircuitFailureThreshold: 2,
      policyCircuitCooldownMs: 150,
      walletCircuitFailureThreshold: 2,
      lifecycleCircuitFailureThreshold: 2,
      verificationCircuitFailureThreshold: 2,
      rateLimitMax: 1000,
    });
    await app.ready();

    try {
      // 1. Trigger 2 connection failures on policy-service to trip its circuit breaker
      const fail1 = await app.inject({ method: "GET", url: "/policies/list" });
      expect(fail1.statusCode).toBeGreaterThanOrEqual(500);
      const fail2 = await app.inject({ method: "GET", url: "/policies/list" });
      expect(fail2.statusCode).toBeGreaterThanOrEqual(500);

      // 2. policy-service breaker is now OPEN on both /policies and /v1/policies
      const tripped = await app.inject({ method: "GET", url: "/policies/list" });
      expect(tripped.statusCode).toBe(503);
      expect(tripped.json()).toMatchObject({
        error: {
          code: "policy_service_unavailable",
          message: "Circuit breaker open: policy-service is failing.",
        },
      });
      expect(tripped.json().error.details.retryAfterMs).toBeGreaterThan(0);

      const trippedV1 = await app.inject({ method: "GET", url: "/v1/policies/list" });
      expect(trippedV1.statusCode).toBe(503);
      expect(trippedV1.json()).toMatchObject({
        error: { code: "policy_service_unavailable" },
      });

      // 3. All other three upstreams remain CLOSED and serve traffic normally
      const walletRes = await app.inject({ method: "GET", url: "/wallet/status" });
      expect(walletRes.statusCode).toBe(200);
      expect(walletRes.json()).toEqual({ service: "wallet-service", status: "ok" });

      const walletV1Res = await app.inject({ method: "GET", url: "/v1/wallet/status" });
      expect(walletV1Res.statusCode).toBe(200);

      const lifecycleRes = await app.inject({ method: "GET", url: "/lifecycle/status" });
      expect(lifecycleRes.statusCode).toBe(200);
      expect(lifecycleRes.json()).toEqual({ service: "lifecycle-service", status: "ok" });

      const verificationRes = await app.inject({ method: "GET", url: "/verification/status" });
      expect(verificationRes.statusCode).toBe(200);
      expect(verificationRes.json()).toEqual({ service: "verification-service", status: "ok" });

      // 4. Start policy-service and wait past cooldownMs (150ms) to verify half-open recovery
      await policyUpstream.listen({ port: policyPort, host: "127.0.0.1" });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const halfOpenProbe = await app.inject({ method: "GET", url: "/policies/list" });
      expect(halfOpenProbe.statusCode).toBe(200);
      expect(halfOpenProbe.json()).toEqual({
        service: "policy-service",
        policies: ["spending_limit"],
      });

      // Subsequent requests succeed with the breaker closed again
      const afterRecovery = await app.inject({ method: "GET", url: "/v1/policies/list" });
      expect(afterRecovery.statusCode).toBe(200);
    } finally {
      await app.close();
      await walletUpstream.close();
      await lifecycleUpstream.close();
      await verificationUpstream.close();
      await policyUpstream.close();
    }
  });

  it("re-opens immediately if the half-open probe fails during cooldown recovery", async () => {
    let now = 1_000;
    const transitions: Array<{ from: string; to: string }> = [];
    const app = Fastify({ logger: false });
    const hooks = createProxyCircuitBreakerHooks(app, {
      serviceName: "policy-service",
      failureThreshold: 2,
      cooldownMs: 500,
      now: () => now,
      onStateChange: (from, to) => transitions.push({ from, to }),
    });

    expect(hooks.breaker.state).toBe("closed");

    hooks.breaker.beforeCall();
    hooks.breaker.recordOutcome("failure");
    hooks.breaker.beforeCall();
    hooks.breaker.recordOutcome("failure");
    expect(hooks.breaker.state).toBe("open");

    // Advance past cooldown -> beforeCall transitions open -> half_open
    now += 600;
    hooks.breaker.beforeCall();
    expect(hooks.breaker.state).toBe("half_open");

    // Probe fails -> immediately re-opens
    hooks.breaker.recordOutcome("failure");
    expect(hooks.breaker.state).toBe("open");
    expect(transitions).toEqual([
      { from: "closed", to: "open" },
      { from: "open", to: "half_open" },
      { from: "half_open", to: "open" },
    ]);

    // Advance past cooldown again -> probe succeeds -> closes
    now += 600;
    hooks.breaker.beforeCall();
    hooks.breaker.recordOutcome("success");
    expect(hooks.breaker.state).toBe("closed");

    await app.close();
  });

  it("allows any custom route registered via registerVersionedProxyRoute to opt into an isolated breaker", async () => {
    const deadPort = await reserveUnusedPort();
    const app = Fastify({ logger: false });
    registerVersionedProxyRoute(app, {
      upstream: `http://127.0.0.1:${deadPort}`,
      prefix: "/custom-upstream",
      circuitBreaker: {
        serviceName: "custom-upstream",
        failureThreshold: 1,
        cooldownMs: 30_000,
      },
    });
    await app.ready();

    try {
      const first = await app.inject({ method: "GET", url: "/custom-upstream/test" });
      expect(first.statusCode).toBeGreaterThanOrEqual(500);

      const second = await app.inject({ method: "GET", url: "/v1/custom-upstream/test" });
      expect(second.statusCode).toBe(503);
      expect(second.json()).toMatchObject({
        error: {
          code: "custom_upstream_unavailable",
          message: "Circuit breaker open: custom-upstream is failing.",
        },
      });
    } finally {
      await app.close();
    }
  });
});
