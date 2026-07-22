import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { registerHealth, registerMetrics } from "@vela/service-kit";
import type { VerificationRecord } from "@vela/types";

// Verification API (idea.md §11, technical-doc.md §5.5/§7.6): a developer submits
// a contract's source (repo+commit or upload) and build metadata; the service
// stores a VerificationRecord and enqueues a deterministic-rebuild job. A build
// worker (worker-service) later rebuilds, hashes the artifact, compares it to
// the deployed contract's wasm hash, and flips the record to verified/failed.
//
// This service NEVER runs untrusted builds itself — that is worker-service's job,
// in an isolated process (§8.4). Here we only accept submissions, persist
// records, hand jobs to a queue seam, and expose read APIs. The queue and the
// repository are seams so the routes are testable without Postgres or a worker.

/**
 * A verification record plus the fields the pipeline needs beyond the public
 * shape in @vela/types: the build log (surfaced on failure) and the source
 * archive reference for upload submissions.
 */
export interface VerificationRecordInternal extends VerificationRecord {
  /** Present for sourceType "upload": an opaque reference to the stored archive. */
  sourceArchiveRef?: string;
  /** Optional lockfile digest, part of the deterministic-build inputs (idea.md §6.3). */
  lockfileHash?: string;
  /** Human-readable build/compare log, populated by the worker (esp. on failure). */
  log?: string;
}

export interface VerificationRepository {
  insert(record: VerificationRecordInternal): Promise<void>;
  find(id: string): Promise<VerificationRecordInternal | undefined>;
  /** All records for a contract, newest first — a contract may be resubmitted. */
  findByContract(contractId: string): Promise<VerificationRecordInternal[]>;
  update(record: VerificationRecordInternal): Promise<void>;
}

export function createMemoryVerificationRepository(): VerificationRepository {
  const records = new Map<string, VerificationRecordInternal>();
  return {
    async insert(record) {
      records.set(record.id, record);
    },
    async find(id) {
      return records.get(id);
    },
    async findByContract(contractId) {
      return [...records.values()]
        .filter((r) => r.contractId === contractId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async update(record) {
      records.set(record.id, record);
    },
  };
}

/** The job handed to the build pipeline. Mirrors the deterministic-build inputs
 * (idea.md §6.3) — everything a worker needs to reproduce the artifact. */
export interface BuildJob {
  recordId: string;
  contractId: string;
  sourceType: "repo" | "upload";
  repoUrl?: string;
  commitHash?: string;
  sourceArchiveRef?: string;
  toolchainVersion: string;
  buildFlags?: string[];
}

/** Where submitted jobs go. In-process for tests/dev; a real queue (or a shared
 * table the worker polls) behind the same interface in production. */
export interface BuildJobQueue {
  enqueue(job: BuildJob): Promise<void>;
}

/** A no-op queue: records are created but never built (status stays "submitted").
 * Used when no worker is wired — the read/submit API still works. */
export function createNoopBuildJobQueue(): BuildJobQueue {
  return { async enqueue() {} };
}

// A Stellar contract address (C… strkey). Verification only targets deployed
// Soroban contracts, so classic G-addresses are rejected at the schema.
const contractIdSchema = z
  .string()
  .regex(/^C[A-Z2-7]{55}$/, "must be a deployed contract address (C…)");

const submitBodySchema = z
  .object({
    contractId: contractIdSchema,
    sourceType: z.enum(["repo", "upload"]),
    repoUrl: z.string().url().optional(),
    commitHash: z
      .string()
      .regex(/^[0-9a-fA-F]{7,40}$/, "must be a git commit sha")
      .optional(),
    sourceArchiveRef: z.string().min(1).optional(),
    toolchainVersion: z.string().min(1),
    buildFlags: z.array(z.string()).optional(),
    lockfileHash: z.string().min(1).optional(),
  })
  // A repo submission needs a repoUrl + commit to be reproducible; an upload
  // needs the archive reference. Enforce the pairing so we never queue a job
  // that can't possibly build deterministically.
  .superRefine((val, ctx) => {
    if (val.sourceType === "repo") {
      if (!val.repoUrl) {
        ctx.addIssue({
          code: "custom",
          path: ["repoUrl"],
          message: "repoUrl is required for repo submissions",
        });
      }
      if (!val.commitHash) {
        ctx.addIssue({
          code: "custom",
          path: ["commitHash"],
          message: "commitHash is required for repo submissions",
        });
      }
    } else if (val.sourceType === "upload" && !val.sourceArchiveRef) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceArchiveRef"],
        message: "sourceArchiveRef is required for upload submissions",
      });
    }
  });

export interface VerificationServiceDeps {
  records?: VerificationRepository;
  queue?: BuildJobQueue;
  now?: () => Date;
}

export function buildServer(deps: VerificationServiceDeps = {}): FastifyInstance {
  const records = deps.records ?? createMemoryVerificationRepository();
  const queue = deps.queue ?? createNoopBuildJobQueue();
  const now = deps.now ?? (() => new Date());

  const app = Fastify({ logger: true });
  registerHealth(app, "verification-service");
  registerMetrics(app, "verification-service");

  // POST /verification/submit — record the submission and enqueue a build job.
  app.post("/verification/submit", async (request, reply) => {
    const parsed = submitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const input = parsed.data;
    const timestamp = now().toISOString();
    const record: VerificationRecordInternal = {
      id: randomUUID(),
      contractId: input.contractId,
      sourceType: input.sourceType,
      repoUrl: input.repoUrl,
      commitHash: input.commitHash,
      sourceArchiveRef: input.sourceArchiveRef,
      toolchainVersion: input.toolchainVersion,
      buildFlags: input.buildFlags,
      lockfileHash: input.lockfileHash,
      status: "submitted",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await records.insert(record);

    // Enqueue the build. If the queue rejects (worker/queue down) the submission
    // still stands as "submitted" and can be retried — we don't lose the record.
    try {
      await queue.enqueue({
        recordId: record.id,
        contractId: record.contractId,
        sourceType: record.sourceType,
        repoUrl: record.repoUrl,
        commitHash: record.commitHash,
        sourceArchiveRef: record.sourceArchiveRef,
        toolchainVersion: record.toolchainVersion,
        buildFlags: record.buildFlags,
      });
    } catch (err) {
      request.log.error({ err, recordId: record.id }, "failed to enqueue build job");
    }

    return reply.code(201).send({ record: toPublic(record) });
  });

  // GET /verification/:contractId — full verification history for a contract.
  app.get("/verification/:contractId", async (request, reply) => {
    const parsed = contractIdSchema.safeParse(
      (request.params as { contractId: string }).contractId,
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_contract_id" });
    }
    const found = await records.findByContract(parsed.data);
    return reply.send({ contractId: parsed.data, records: found.map(toPublic) });
  });

  // GET /verification/:contractId/status — the cheap trust-signal lookup used by
  // the badge in web + extension (§5.5). Returns the latest record's status, or
  // "unverified" when nothing has ever been submitted for the contract.
  app.get("/verification/:contractId/status", async (request, reply) => {
    const parsed = contractIdSchema.safeParse(
      (request.params as { contractId: string }).contractId,
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_contract_id" });
    }
    const found = await records.findByContract(parsed.data);
    const latest = found[0];
    return reply.send({
      contractId: parsed.data,
      status: latest?.status ?? "unverified",
      recordId: latest?.id,
      updatedAt: latest?.updatedAt,
    });
  });

  return app;
}

/** Strip internal-only fields (archive ref, lockfile hash) from API responses —
 * the public record is the @vela/types shape plus the build log. */
function toPublic(record: VerificationRecordInternal): VerificationRecord & { log?: string } {
  const { sourceArchiveRef: _ref, lockfileHash: _lock, ...pub } = record;
  return pub;
}
