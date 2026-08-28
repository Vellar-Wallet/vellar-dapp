import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// Hourly bucketing: 30 hardcoded sample points each in their own hour ->
// 30 buckets, one sample each.
const hourly = handleRequest({ bucket: "hourly" });
assert.equal(hourly.status, 200);
assert.equal(hourly.body.bucket, "hourly");
assert.equal(hourly.body.buckets.length, 30);
assert.ok(hourly.body.buckets.every((b) => b.samples === 1));

// Daily bucketing: the 30 hourly points span two calendar days.
const daily = handleRequest({ bucket: "daily" });
assert.equal(daily.status, 200);
assert.equal(daily.body.bucket, "daily");
assert.equal(daily.body.buckets.length, 2);
const totalDailySamples = daily.body.buckets.reduce((acc, b) => acc + b.samples, 0);
assert.equal(totalDailySamples, 30);

// Default bucket (no query param) falls back to hourly.
const defaulted = handleRequest({});
assert.equal(defaulted.body.bucket, "hourly");

console.log("PASS: /rate-history buckets sample points hourly and daily");
