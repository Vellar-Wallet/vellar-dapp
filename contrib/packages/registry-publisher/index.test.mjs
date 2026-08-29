import assert from "node:assert/strict";
import { publishToRegistry } from "./index.mjs";

const HASH = "0f6b858d61799a33efdc2303c60eb0c148fd2983b7d2336fc345b5492a24b791";

function makeMetrics() {
  const calls = [];
  return {
    calls,
    inc(labels) {
      calls.push(labels);
    },
  };
}

function makeDeps(overrides = {}) {
  const calls = [];
  const txSender = overrides.txSender ?? {
    invokeContract: async (...args) => {
      calls.push(args);
      return { txHash: "tx-abc-123" };
    },
  };
  return {
    txSender,
    adminSecret: "SAXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    registryContractId: "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67",
    network: "testnet",
    ...overrides,
  };
}

// 1. Verified record publishes once
{
  const metrics = makeMetrics();
  const deps = makeDeps({ metrics });
  const result = await publishToRegistry(HASH, "verified", deps);
  assert.equal(result.published, true);
  assert.ok(result.message.includes("tx"));
  assert.equal(metrics.calls.length, 1);
  assert.equal(metrics.calls[0].outcome, "success");
  console.log("PASS: verified record publishes once");
}

// 2. Failed record never publishes
{
  const metrics = makeMetrics();
  const deps = makeDeps({ metrics });
  const result = await publishToRegistry(HASH, "failed", deps);
  assert.equal(result.published, false);
  assert.ok(result.message.includes("Skipped"));
  assert.equal(metrics.calls.length, 0);
  console.log("PASS: failed record never publishes");
}

// 3. Pending record never publishes
{
  const metrics = makeMetrics();
  const deps = makeDeps({ metrics });
  const result = await publishToRegistry(HASH, "pending", deps);
  assert.equal(result.published, false);
  assert.equal(metrics.calls.length, 0);
  console.log("PASS: pending record never publishes");
}

// 4. Repeat publication is a no-op (idempotent)
{
  const metrics = makeMetrics();
  let callCount = 0;
  const deps = makeDeps({
    metrics,
    txSender: {
      invokeContract: async () => {
        callCount++;
        if (callCount === 1) return { txHash: "tx-1" };
        throw new Error("AlreadyVerified: hash exists");
      },
    },
  });

  const r1 = await publishToRegistry(HASH, "verified", deps);
  assert.equal(r1.published, true);

  const r2 = await publishToRegistry(HASH, "verified", deps);
  assert.equal(r2.published, true);
  assert.ok(r2.message.includes("idempotent"));

  assert.equal(metrics.calls.length, 2);
  assert.equal(metrics.calls[0].outcome, "success");
  assert.equal(metrics.calls[1].outcome, "success");
  console.log("PASS: repeat publication is idempotent no-op");
}

// 5. Registry write failure is retryable (error propagated)
{
  const metrics = makeMetrics();
  const deps = makeDeps({
    metrics,
    txSender: {
      invokeContract: async () => {
        throw new Error("network timeout");
      },
    },
  });

  let caught = false;
  try {
    await publishToRegistry(HASH, "verified", deps);
  } catch (err) {
    caught = true;
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("network timeout"));
  }
  assert.equal(caught, true);
  assert.equal(metrics.calls.length, 1);
  assert.equal(metrics.calls[0].outcome, "failure");
  console.log("PASS: registry write failure is retryable");
}

// 6. Metrics not incremented for skipped records
{
  const metrics = makeMetrics();
  const deps = makeDeps({ metrics });
  await publishToRegistry(HASH, "failed", deps);
  await publishToRegistry(HASH, "pending", deps);
  assert.equal(metrics.calls.length, 0);
  console.log("PASS: metrics not incremented for skipped records");
}

console.log("\nAll registry-publisher tests passed!");
