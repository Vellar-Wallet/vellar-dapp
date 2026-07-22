import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  createMemoryVerificationRepository,
  createNoopBuildJobQueue,
  type VerificationRepository,
} from "@vela/verification-service/server";
import { stubBuildExecutor } from "./executor";
import { createStaticArtifactResolver } from "./resolver";
import { runWorkerTick } from "./loop";
import type { VerificationJobStore } from "./job-store";

// e2e: verify contract source (idea.md §15). Exercises the full pipeline end to
// end against the REAL verification-service Fastify server and the REAL worker
// loop, sharing one repository — the same arrangement used in production over
// Postgres (the submitted record row IS the job):
//   submit (API) → worker claims → stub build → hash compared to deployed hash
//   → record flipped to verified/failed → status API reflects it.
//
// The build uses the deterministic stub executor (real Rust/Docker builds can't
// run in CI — the 1A constraint). The deployed hash is wired to what the stub
// produces to exercise a genuine match; a second contract is wired to a
// different hash for the mismatch path; a third resolves to nothing.

const C_MATCH = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const C_MISMATCH = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A worker job store over the SAME repository the API writes to — the
 * production Postgres arrangement. Claims by the contract ids under test. */
function jobStoreOver(
  records: VerificationRepository,
  contractIds: string[],
): VerificationJobStore {
  return {
    async claimSubmitted(limit) {
      const claimed = [];
      for (const contractId of contractIds) {
        for (const r of await records.findByContract(contractId)) {
          if (claimed.length >= limit) break;
          if (r.status === "submitted") {
            r.status = "building";
            await records.update(r);
            claimed.push({
              recordId: r.id,
              contractId: r.contractId,
              sourceType: r.sourceType,
              repoUrl: r.repoUrl,
              commitHash: r.commitHash,
              sourceArchiveRef: r.sourceArchiveRef,
              toolchainVersion: r.toolchainVersion,
              buildFlags: r.buildFlags,
            });
          }
        }
      }
      return claimed;
    },
    async complete(recordId, result) {
      const r = await records.find(recordId);
      if (!r) return;
      r.status = result.status;
      r.outputHash = result.outputHash;
      r.deployedHash = result.deployedHash;
      r.log = result.log;
      r.updatedAt = new Date().toISOString();
      await records.update(r);
    },
  };
}

async function submit(server: FastifyInstance, contractId: string) {
  const res = await server.inject({
    method: "POST",
    url: "/verification/submit",
    payload: {
      contractId,
      sourceType: "repo",
      repoUrl: "https://github.com/example/contract",
      commitHash: "a1b2c3d",
      toolchainVersion: "1.81.0",
      buildFlags: ["--release"],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().record.id as string;
}

async function status(server: FastifyInstance, contractId: string) {
  const res = await server.inject({ method: "GET", url: `/verification/${contractId}/status` });
  return res.json().status as string;
}

describe("verify contract source — full pipeline (idea.md §15)", () => {
  it("submit → worker build → hash match → verified, reflected in the status API", async () => {
    const records = createMemoryVerificationRepository();
    app = buildServer({ records, queue: createNoopBuildJobQueue() });

    // Deployed hash == what the stub build produces for this job ⇒ a real match.
    const executor = stubBuildExecutor();
    const built = await executor.build({
      sourceType: "repo",
      repoUrl: "https://github.com/example/contract",
      commitHash: "a1b2c3d",
      toolchainVersion: "1.81.0",
      buildFlags: ["--release"],
    });
    const resolver = createStaticArtifactResolver({ [C_MATCH]: built.wasmHash });
    const store = jobStoreOver(records, [C_MATCH]);

    await submit(app, C_MATCH);
    expect(await status(app, C_MATCH)).toBe("submitted");

    const handled = await runWorkerTick({ store, executor, resolver });
    expect(handled).toBe(1);

    expect(await status(app, C_MATCH)).toBe("verified");
  });

  it("submit → build → hash mismatch → failed, with both hashes in the record", async () => {
    const records = createMemoryVerificationRepository();
    app = buildServer({ records, queue: createNoopBuildJobQueue() });

    const resolver = createStaticArtifactResolver({ [C_MISMATCH]: "d".repeat(64) });
    const store = jobStoreOver(records, [C_MISMATCH]);

    await submit(app, C_MISMATCH);
    await runWorkerTick({ store, executor: stubBuildExecutor(), resolver });

    expect(await status(app, C_MISMATCH)).toBe("failed");

    const history = await app.inject({ method: "GET", url: `/verification/${C_MISMATCH}` });
    const record = history.json().records[0];
    expect(record.status).toBe("failed");
    expect(record.deployedHash).toBe("d".repeat(64));
    expect(record.outputHash).toBeTruthy();
    expect(record.log).toContain("Mismatch");
  });

  it("a contract that can't be resolved on-chain fails with a clear reason (no build)", async () => {
    const records = createMemoryVerificationRepository();
    app = buildServer({ records, queue: createNoopBuildJobQueue() });

    const resolver = createStaticArtifactResolver({}); // nothing resolves
    const store = jobStoreOver(records, [C_MATCH]);

    await submit(app, C_MATCH);
    await runWorkerTick({ store, executor: stubBuildExecutor(), resolver });

    expect(await status(app, C_MATCH)).toBe("failed");
    const history = await app.inject({ method: "GET", url: `/verification/${C_MATCH}` });
    expect(history.json().records[0].log).toContain("Could not resolve");
  });
});
