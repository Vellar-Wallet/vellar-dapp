import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  createMemoryVerificationRepository,
  fakeFacilitatorClient,
  toPublic,
  type BuildJob,
  type BuildJobQueue,
  type VerificationRecordInternal,
  type VerificationServiceDeps,
} from "./server";

// A real deployed contract strkey (C…) and an invalid one for validation tests.
const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const C2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";

// buildServer() calls publicBaseUrlFromEnv() at construction time (see
// docs/decisions.md — fails closed on purpose so a missing public URL never
// falls back to publishing an internal bind address). Tests need a real,
// valid value in the environment for that call to succeed.
const PREVIOUS_RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
beforeAll(() => {
  process.env.RENDER_EXTERNAL_URL = "https://vellar-backend.onrender.com";
});
afterAll(() => {
  if (PREVIOUS_RENDER_EXTERNAL_URL === undefined) {
    delete process.env.RENDER_EXTERNAL_URL;
  } else {
    process.env.RENDER_EXTERNAL_URL = PREVIOUS_RENDER_EXTERNAL_URL;
  }
});

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
  app = buildServer({
    records,
    queue: q.queue,
    x402FacilitatorClient: fakeFacilitatorClient(),
    ...deps,
  });
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
    app = buildServer({
      records,
      queue: failingQueue,
      x402FacilitatorClient: fakeFacilitatorClient(),
    });
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

describe("POST /verification/submit — queue controls (M7)", () => {
  async function submit(app: FastifyInstance, contractId = C1) {
    return app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: { ...validRepoSubmission, contractId },
    });
  }

  it("dedups: a second active submission for the same contract is rejected (409)", async () => {
    const { app } = build();
    expect((await submit(app)).statusCode).toBe(201);
    const dup = await submit(app);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("verification_in_progress");
  });

  it("allows resubmission of a contract whose prior run is terminal", async () => {
    const records = createMemoryVerificationRepository();
    app = buildServer({ records, x402FacilitatorClient: fakeFacilitatorClient() });
    const first = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: validRepoSubmission,
    });
    const id = first.json().record.id;
    // Mark the prior run terminal.
    const rec = await records.find(id);
    await records.update({ ...rec!, status: "verified" });
    // Same contract can be resubmitted.
    const again = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: validRepoSubmission,
    });
    expect(again.statusCode).toBe(201);
  });

  it("queue-depth cap: rejects (429) once active records reach maxActiveQueue", async () => {
    const records = createMemoryVerificationRepository();
    app = buildServer({
      records,
      maxActiveQueue: 2,
      x402FacilitatorClient: fakeFacilitatorClient(),
    });
    // Two distinct contracts fill the queue to the cap.
    expect((await submit(app, C1)).statusCode).toBe(201);
    expect((await submit(app, C2)).statusCode).toBe(201);
    // A third distinct contract is over the cap.
    const over = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: {
        ...validRepoSubmission,
        contractId: "CQW7RHWTWHWNIBTEQ7JDYNGHQ4VNXLFRPKW3B4ABM2MZBLVS5LTCCUAH",
      },
    });
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe("queue_full");
  });
});

describe("GET /verification/:contractId", () => {
  it("requires x402 payment (402 without a valid X-PAYMENT header)", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: `/verification/${C1}` });
    expect(res.statusCode).toBe(402);
  });

  // KNOWN GAP: paymentMiddleware gates this route ahead of the handler, so
  // every test below — including "400s on an invalid contract id", which
  // used to prove bad input was rejected for free — is now unreachable via
  // app.inject() (no in-process way to satisfy the x402 challenge with a
  // signed payment). This also means a caller with a malformed contractId
  // now pays before finding out their input was invalid; flagged, not fixed,
  // per docs/decisions.md.
  it.skip("returns the full history newest-first", async () => {
    const records = createMemoryVerificationRepository();
    let clock = 1000;
    app = buildServer({
      records,
      now: () => new Date(clock),
      x402FacilitatorClient: fakeFacilitatorClient(),
    });

    const first = await app.inject({
      method: "POST",
      url: "/verification/submit",
      payload: validRepoSubmission,
    });
    // A contract can be RE-verified over time, but only after the prior run is
    // terminal (dedup blocks a second concurrent active run — M7). Terminalize
    // the first run, then submit again to build a 2-entry history.
    const firstId = first.json().record.id;
    const rec = await records.find(firstId);
    await records.update({ ...rec!, status: "verified" });

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

  it.skip("returns an empty list for a contract with no submissions", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: `/verification/${C2}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().records).toEqual([]);
  });

  // /verification/:contractId is x402-gated (paymentMiddleware intercepts
  // onRequest before the handler runs), so an unauthenticated app.inject()
  // can no longer reach toPublic() through the HTTP layer — there is no
  // in-process way to satisfy a real x402 payment challenge without a signed
  // Stellar authorization entry, which this suite has no seam to fabricate.
  // Test the redaction guarantee directly against the exported unit instead:
  // same function, no route dependency, no payment.
  it("toPublic() strips the private build log but returns the public statusDetail (H3/FIX 6)", () => {
    const stored: VerificationRecordInternal = {
      id: "rec_1",
      contractId: C1,
      sourceType: "repo",
      status: "failed",
      toolchainVersion: "1.81.0",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      log: "git clone stderr: fatal: could not read from /Users/op/.ssh/id_rsa; host 10.0.0.5",
      statusDetail: "Build failed (clone_failed).",
    };

    const rec = toPublic(stored);
    expect(rec.statusDetail).toBe("Build failed (clone_failed).");
    // The private log (with host paths / internal host) must NOT be exposed.
    // `log` isn't even in toPublic()'s return type — this only compiles
    // because we assert on the untyped JSON serialization, not `rec.log`.
    expect("log" in rec).toBe(false);
    expect(JSON.stringify(rec)).not.toContain("id_rsa");
    expect(JSON.stringify(rec)).not.toContain("10.0.0.5");
  });

  it.skip("400s on an invalid contract id", async () => {
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

describe("x402 public resource URL guard (docs/decisions.md — localhost catalog incident)", () => {
  it("buildServer() refuses to start when no public base URL is configured", () => {
    const previous = process.env.RENDER_EXTERNAL_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    try {
      expect(() => build()).toThrow(/No public base URL configured/);
    } finally {
      if (previous === undefined) delete process.env.RENDER_EXTERNAL_URL;
      else process.env.RENDER_EXTERNAL_URL = previous;
    }
  });

  it("buildServer() refuses to start with the exact localhost value from the incident", () => {
    const previous = process.env.RENDER_EXTERNAL_URL;
    process.env.RENDER_EXTERNAL_URL = "http://localhost:4002";
    try {
      expect(() => build()).toThrow(/localhost:4002/);
    } finally {
      if (previous === undefined) delete process.env.RENDER_EXTERNAL_URL;
      else process.env.RENDER_EXTERNAL_URL = previous;
    }
  });

  it("registers the real public URL (not localhost) once /verification/:contractId is discoverable", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: `/verification/${C1}` });
    expect(res.statusCode).toBe(402);
    const challengeB64 = res.headers["payment-required"] as string;
    const challenge = JSON.parse(Buffer.from(challengeB64, "base64").toString("utf8"));
    expect(challenge.resource.url).toBe(
      "https://vellar-backend.onrender.com/verification/:contractId",
    );
    expect(challenge.resource.url).not.toContain("localhost");
  });
});
