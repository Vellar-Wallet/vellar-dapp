import assert from "node:assert/strict";
import { ChaosQueueConsumerManager, handleRequest } from "./route.mjs";

const manager = new ChaosQueueConsumerManager();

// Test 1: Enqueue job
const job = manager.enqueueJob(
  "job-chaos-1",
  "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67",
);
assert.equal(job.status, "submitted");
assert.equal(job.attempts, 0);

// Test 2: Consumer 1 claims job
const claimedBy1 = manager.claimNextJob("worker-node-1");
assert.equal(claimedBy1.id, "job-chaos-1");
assert.equal(claimedBy1.status, "building");
assert.equal(claimedBy1.claimedBy, "worker-node-1");
assert.equal(claimedBy1.attempts, 1);

// Test 3: Consumer 1 crashes mid-job -> lock released
manager.simulateConsumerCrash("worker-node-1");
const crashedJobState = manager.getJobState("job-chaos-1");
assert.equal(crashedJobState.status, "building");
assert.equal(crashedJobState.claimedBy, null); // Lock released

// Test 4: Consumer 2 reclaims unacknowledged job & completes
const claimedBy2 = manager.claimNextJob("worker-node-2");
assert.equal(claimedBy2.claimedBy, "worker-node-2");
assert.equal(claimedBy2.attempts, 2);

const completedJob = manager.processAndCompleteJob("worker-node-2", "job-chaos-1", "verified");
assert.equal(completedJob.status, "verified");
assert.equal(completedJob.claimedBy, null);

// Test 5: Endpoint simulation
const apiRes = handleRequest({});
assert.equal(apiRes.status, 200);
assert.equal(apiRes.body.finalJob.status, "verified");

console.log("PASS: Issue 319 worker-service queue consumer chaos tests passed cleanly!");
