import assert from "node:assert/strict";
import { GatewayAlertMonitor, handleRequest } from "./route.mjs";

// Test 1: Normal traffic does not trigger alert
const monitorNormal = new GatewayAlertMonitor(5.0, 60);
for (let i = 0; i < 98; i++) monitorNormal.recordRequest(200);
for (let i = 0; i < 2; i++) monitorNormal.recordRequest(500); // 2% error rate < 5% threshold

const evalNormal = monitorNormal.evaluateAlert();
assert.equal(evalNormal.triggered, false);
assert.equal(evalNormal.errorRatePercent, 2);

// Test 2: Synthetic load above threshold triggers alert with correct payload & runbook link
const monitorElevated = new GatewayAlertMonitor(5.0, 60);
for (let i = 0; i < 90; i++) monitorElevated.recordRequest(200);
for (let i = 0; i < 10; i++) monitorElevated.recordRequest(503); // 10% error rate > 5% threshold

const evalElevated = monitorElevated.evaluateAlert();
assert.equal(evalElevated.triggered, true);
assert.equal(evalElevated.alert.alert, "ApiGatewayElevated5xxRate");
assert.equal(evalElevated.alert.channel, "#on-call-incidents");
assert.ok(evalElevated.alert.runbookUrl.includes("api-gateway-5xx-elevated-rate"));

// Test 3: Handler API simulation
const apiRes = handleRequest({ body: { syntheticLoad: true } });
assert.equal(apiRes.status, 200);
assert.equal(apiRes.body.triggered, true);

console.log("PASS: Issue 305 gateway 5xx rate alerting tests passed cleanly!");
