import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  createMemoryVerificationRepository,
  type BuildJob,
  type BuildJobQueue,
  type VerificationServiceDeps,
} from "./server";

// A real deployed contract strkey (C…) and an invalid one for validation tests.
const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const C2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A recording queue so we can assert what job was enqueued. */
function recordingQueue() {
  const jobs: BuildJob[] = [];
  const queue: BuildJobQueue = {
    async enqueue(job) {
      jobs.push(job);
    },
  };
  return { queue, jobs };
}

function build(deps: VerificationServiceDeps = {}) {
  const records = deps.records ?? createMemoryVerificationRepository();
  const q = recordingQueue();
  app = buildServer({ records, queue: q.queue, ...deps });
  return { app, records, jobs: q.jobs };
}

const validRepoSubmission = {
  contractId: C1,
  sourceType: "repo" as const,
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.81.0",
  buildFlags: ["--release"],
};

describe("POST /verification/submit", () => {
  it("creates a submitted record and enqueues a build job", async () => {
    const { app, records, jobs } = build();

    const res = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: validRepoSubmission,
    });

    expect(res.statusCode).toBe(201);
    const { record } = res.json();
    expect(record.status).toBe("submitted");
    expect(record.contractId).toBe(C1);
    expect(record.id).toBeTruthy();
    expect(record.createdAt).toBe(record.updatedAt);

    // Persisted and enqueued with the same id.
    const stored = await records.find(record.id);
    expect(stored?.status).toBe("submitted");
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job?.recordId).toBe(record.id);
    expect(job?.contractId).toBe(C1);
    expect(job?.commitHash).toBe("a1b2c3d");
  });

  it("accepts an upload submission with an archive ref", async () => {
    const { app, jobs } = build();
    const res = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: {
        contractId: C2,
        sourceType: "upload",
        sourceArchiveRef: "archive://abc123",
        toolchainVersion: "1.81.0",
      },
    });
    expect(res.statusCode).toBe(201);
    const [job] = jobs;
    expect(job?.sourceType).toBe("upload");
    expect(job?.sourceArchiveRef).toBe("archive://abc123");
  });

  it("does not leak internal fields (archive ref, lockfile hash) in the response", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: {
        contractId: C2,
        sourceType: "upload",
        sourceArchiveRef: "archive://secret",
        lockfileHash: "deadbeef",
        toolchainVersion: "1.81.0",
      },
    });
    const { record } = res.json();
    expect(record.sourceArchiveRef).toBeUndefined();
    expect(record.lockfileHash).toBeUndefined();
  });

  it("rejects a classic G-address as the contract id", async () => {
    const { app, jobs } = build();
    const res = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: { ...validRepoSubmission, contractId: G1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
    expect(jobs).toHaveLength(0);
  });

  it("rejects a repo submission missing repoUrl or commitHash", async () => {
    const { app, jobs } = build();
    const missingUrl = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: {
        contractId: C1,
        sourceType: "repo",
        commitHash: "a1b2c3d",
        toolchainVersion: "1.81.0",
      },
    });
    expect(missingUrl.statusCode).toBe(400);

    const missingCommit = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: {
        contractId: C1,
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        toolchainVersion: "1.81.0",
      },
    });
    expect(missingCommit.statusCode).toBe(400);
    expect(jobs).toHaveLength(0);
  });

  it("rejects an upload submission with no archive ref", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: { contractId: C1, sourceType: "upload", toolchainVersion: "1.81.0" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing toolchain version", async () => {
    const { app } = build();
    const { toolchainVersion: _omit, ...noToolchain } = validRepoSubmission;
    const res = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: noToolchain,
    });
    expect(res.statusCode).toBe(400);
  });

  it("still records the submission if enqueue fails (record is not lost)", async () => {
    const records = createMemoryVerificationRepository();
    const failingQueue: BuildJobQueue = {
      async enqueue() {
        throw new Error("queue down");
      },
    };
    app = buildServer({ records, queue: failingQueue });
    const res = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: validRepoSubmission,
    });
    expect(res.statusCode).toBe(201);
    const { record } = res.json();
    expect((await records.find(record.id))?.status).toBe("submitted");
  });
});

describe("GET /verification/:contractId", () => {
  it("returns the full history newest-first", async () => {
    const records = createMemoryVerificationRepository();
    let clock = 1000;
    app = buildServer({ records, now: () => new Date(clock) });

    await app.inject({ method: "POST", url: "/verification/submit", payload: validRepoSubmission });
    clock = 2000;
    await app.inject({ method: "POST", url: "/verification/submit", payload: validRepoSubmission });

    const res = await app.inject({ method: "GET", url: `/verification/${C1}` });
    expect(res.statusCode).toBe(200);
    const { records: found } = res.json();
    expect(found).toHaveLength(2);
    // Newest (clock=2000) first.
    expect(new Date(found[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(found[1].createdAt).getTime(),
    );
  });

  it("returns an empty list for a contract with no submissions", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: `/verification/${C2}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().records).toEqual([]);
  });

  it("400s on an invalid contract id", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: `/verification/${G1}` });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /verification/:contractId/status", () => {
  it("returns unverified for an unknown contract", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: `/verification/${C2}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("unverified");
  });

  it("returns the latest record's status", async () => {
    const records = createMemoryVerificationRepository();
    app = buildServer({ records });
    const submit = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: validRepoSubmission,
    });
    const { record } = submit.json();

    // Simulate the worker flipping it to verified.
    const stored = await records.find(record.id);
    if (!stored) throw new Error("record missing");
    stored.status = "verified";
    stored.outputHash = "hash";
    stored.deployedHash = "hash";
    await records.update(stored);

    const res = await app.inject({ method: "GET", url: `/verification/${C1}/status` });
    expect(res.json().status).toBe("verified");
    expect(res.json().recordId).toBe(record.id);
  });
});

describe("createMemoryVerificationRepository", () => {
  it("findByContract isolates contracts and sorts newest-first", async () => {
    const repo = createMemoryVerificationRepository();
    const base = {
      sourceType: "repo" as const,
      toolchainVersion: "1.81.0",
      status: "submitted" as const,
    };
    await repo.insert({
      id: "a",
      contractId: C1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...base,
    });
    await repo.insert({
      id: "b",
      contractId: C1,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
      ...base,
    });
    await repo.insert({
      id: "c",
      contractId: C2,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      ...base,
    });

    const c1 = await repo.findByContract(C1);
    expect(c1.map((r) => r.id)).toEqual(["b", "a"]);
    const c2 = await repo.findByContract(C2);
    expect(c2.map((r) => r.id)).toEqual(["c"]);
  });
});
