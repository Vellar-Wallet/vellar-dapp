import type { BuildJobQueue } from "../server";

// Over Postgres, the verification_records row IS the job: verification-service
// inserts it with status="submitted", and worker-service polls for and claims
// submitted rows (see worker-service pg-job-store). So there is no separate
// queue to push to — enqueue is a no-op. This keeps the two services decoupled
// (no shared broker) while the shared table coordinates the work, and it
// survives restarts (a submitted row is still there to be claimed).
export function createPgBuildJobQueue(): BuildJobQueue {
  return { async enqueue() {} };
}
