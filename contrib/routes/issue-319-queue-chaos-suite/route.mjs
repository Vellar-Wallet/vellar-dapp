import http from "node:http";

export class ChaosQueueConsumerManager {
  constructor() {
    this.jobs = new Map();
    this.consumerLock = null;
  }

  enqueueJob(jobId, contractId) {
    const job = {
      id: jobId,
      contractId,
      status: "submitted",
      attempts: 0,
      claimedBy: null,
      updatedAt: Date.now(),
    };
    this.jobs.set(jobId, job);
    return job;
  }

  claimNextJob(consumerId) {
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === "submitted" || (job.status === "building" && !job.claimedBy)) {
        job.status = "building";
        job.claimedBy = consumerId;
        job.attempts += 1;
        job.updatedAt = Date.now();
        return job;
      }
    }
    return null;
  }

  simulateConsumerCrash(consumerId) {
    for (const [id, job] of this.jobs.entries()) {
      if (job.claimedBy === consumerId && job.status === "building") {
        // Release lock on crash without marking job as failed
        job.claimedBy = null;
        job.updatedAt = Date.now();
      }
    }
  }

  processAndCompleteJob(consumerId, jobId, outcome = "verified") {
    const job = this.jobs.get(jobId);
    if (!job || job.claimedBy !== consumerId) {
      throw new Error("Job not claimed by consumer");
    }
    job.status = outcome;
    job.claimedBy = null;
    job.updatedAt = Date.now();
    return job;
  }

  getJobState(jobId) {
    return this.jobs.get(jobId);
  }
}

export function handleRequest(req) {
  const manager = new ChaosQueueConsumerManager();
  const job = manager.enqueueJob(
    "job-101",
    "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67",
  );

  // Consumer 1 claims & crashes
  manager.claimNextJob("consumer-1");
  manager.simulateConsumerCrash("consumer-1");

  // Consumer 2 reclaims & completes
  const reclaimed = manager.claimNextJob("consumer-2");
  const finalJob = manager.processAndCompleteJob("consumer-2", "job-101", "verified");

  return { status: 200, body: { finalJob } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    let bodyStr = "";
    req.on("data", (chunk) => (bodyStr += chunk));
    req.on("end", () => {
      const { status, body } = handleRequest({});
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  const port = process.env.PORT || 4319;
  server.listen(port, () => console.log(`issue-319 mock listening on port ${port}`));
}
