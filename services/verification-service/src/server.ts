import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  registerHealth,
  registerMetrics,
  publicBaseUrlFromEnv,
  registerTracing,
} from "@vellar/service-kit";
import type { VerificationRecord } from "@vellar/types";
import { paymentMiddleware, x402ResourceServer } from "@x402/fastify";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";

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
 * shape in @vellar/types: the build log (surfaced on failure) and the source
 * archive reference for upload submissions.
 */
export interface VerificationRecordInternal extends VerificationRecord {
  /** Present for sourceType "upload": an opaque reference to the stored archive. */
  sourceArchiveRef?: string;
  /** Optional lockfile digest, part of the deterministic-build inputs (idea.md §6.3). */
  lockfileHash?: string;
  /** Trace context of the submitting request (#301). Stored on the row so the
   * worker — which claims rows, not HTTP requests — continues the same trace.
   * Internal only: toPublic strips it. */
  traceId?: string;
  traceParentSpanId?: string;
  /** PRIVATE full build/clone output (operators only). Populated by the worker.
   * NEVER returned by the public API — toPublic strips it (security-audit.md
   * H3/FIX 6): it may carry clone stderr, host paths, and resolved IPs. */
  log?: string;
  /** PUBLIC sanitized one-line status returned to submitters — a short reason
   * with no raw build output. Populated by the worker (verify.ts statusDetail). */
  statusDetail?: string;
}

/** Opaque pagination cursor for VerificationRepository.listPage (issue
 * #263): callers pass back a previous page's nextCursor verbatim. */
export type VerificationCursor = string;

export interface VerificationPage {
  records: VerificationRecordInternal[];
  hasMore: boolean;
  /** Present iff hasMore; pass to the next call's `after` filter. */
  nextCursor?: VerificationCursor;
}

export interface VerificationListFilter {
  status?: VerificationRecordInternal["status"];
  limit: number;
  after?: VerificationCursor;
}

export interface VerificationRepository {
  insert(record: VerificationRecordInternal): Promise<void>;
  find(id: string): Promise<VerificationRecordInternal | undefined>;
  /** All records for a contract, newest first — a contract may be resubmitted. */
  findByContract(contractId: string): Promise<VerificationRecordInternal[]>;
  update(record: VerificationRecordInternal): Promise<void>;
  /** Count of ACTIVE records (submitted|building) — queue-depth cap (M7). */
  countActive(): Promise<number>;
  /** True when the contract already has an active (submitted|building) record —
   * per-contractId dedup (M7). */
  hasActiveForContract(contractId: string): Promise<boolean>;
  /** Cursor-paginated, newest-first list across ALL contracts (issue #263) —
   * distinct from findByContract, which is scoped to one contractId and
   * unpaginated (a single contract's resubmission history is small). */
  listPage(filter: VerificationListFilter): Promise<VerificationPage>;
}

/** Encodes a (createdAt, id) keyset position as an opaque cursor token,
 * matching wallet-service's activity-log and policy-service's policy-list
 * pagination in this same batch. Exported for reuse by
 * createPgVerificationRepository. */
export function encodeVerificationCursor(createdAt: string, id: string): VerificationCursor {
  return Buffer.from(`${createdAt}:${id}`, "utf8").toString("base64url");
}

export function decodeVerificationCursor(cursor: VerificationCursor): {
  createdAt: string;
  id: string;
} {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.lastIndexOf(":");
  if (sep <= 0 || sep === decoded.length - 1) {
    throw new Error("malformed verification cursor");
  }
  return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
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
    async countActive() {
      let n = 0;
      for (const r of records.values()) {
        if (r.status === "submitted" || r.status === "building") n++;
      }
      return n;
    },
    async hasActiveForContract(contractId) {
      for (const r of records.values()) {
        if (r.contractId === contractId && (r.status === "submitted" || r.status === "building")) {
          return true;
        }
      }
      return false;
    },
    async listPage(filter) {
      let filtered = [...records.values()];
      if (filter.status) filtered = filtered.filter((r) => r.status === filter.status);

      // Newest first: (createdAt, id) descending — id is the tiebreaker for
      // a shared createdAt, same reasoning as wallet-service's activity log
      // and policy-service's policy list in this same batch: createdAt
      // alone is not a total order.
      filtered.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

      if (filter.after) {
        const decoded = decodeVerificationCursor(filter.after);
        filtered = filtered.filter((r) => {
          if (r.createdAt !== decoded.createdAt) return r.createdAt < decoded.createdAt;
          return r.id < decoded.id;
        });
      }

      const hasMore = filtered.length > filter.limit;
      const page = hasMore ? filtered.slice(0, filter.limit) : filtered;
      const last = page[page.length - 1];
      return {
        records: page,
        hasMore,
        nextCursor: hasMore && last ? encodeVerificationCursor(last.createdAt, last.id) : undefined,
      };
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
  /** Trace context carried to the worker (#301). */
  traceId?: string;
  traceParentSpanId?: string;
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
  /** Max active (submitted|building) records before /verification/submit rejects
   * with 429 (M7 queue-depth cap). This is the real anti-flood control on the
   * last unmetered unauthenticated write path. Default 1000. */
  maxActiveQueue?: number;
  /** x402 facilitator client for the /verification/:contractId payment gate.
   * Defaults to a real HTTPFacilitatorClient hitting vellar-facilitator.
   * Tests inject `fakeFacilitatorClient()` instead: x402ResourceServer.initialize()
   * (run on every buildServer() call) otherwise makes a real network call to the
   * live facilitator per test, which is slow and flaky against a cold Render
   * instance — see docs/decisions.md. */
  x402FacilitatorClient?: FacilitatorClient;
}

/** getSupported() response captured from the live facilitator
 * (curl https://vellar-facilitator.onrender.com/supported, 2026-09-18) for use
 * by fakeFacilitatorClient() below. Re-capture if the facilitator's supported
 * kinds/extensions change. */
function capturedSupportedResponse(): SupportedResponse {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "stellar:pubnet",
        extra: { areFeesSponsored: true },
      },
      {
        x402Version: 2,
        scheme: "upto",
        network: "stellar:pubnet",
        extra: {
          uptoContract: "CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN",
          areFeesSponsored: true,
        },
      },
    ],
    extensions: ["bazaar"],
    signers: {
      "stellar:*": [
        "GDEZOW5M5ODU5SMPXC2XQFAHLRQKK7SSYXDZKMAF7ZKPCAX6KFBTFQZS",
        "GDAP7ZVV7B6YSATUMPBQKZPTS4GODE5ZR3BTBTBDNNBXMPGSOA2TLVUS",
        "GAJFQEVBZCKKFBCCFFUMRHB45CB442JO27LNZ7KIQQMK6GKM7G5R5SOL",
        "GAQDNEHYHTNCGJN5HBS7L7NVIV7LM6HIKXNFDAM7ZLLJFNLAT4QVJKAC",
        "GCHPKEKCK7KPWNO2GYGFEGVP2WJQAAOYT6YGDBXHEVF4JCQJXMQTK6KT",
        "GBB7PVDR642MJSALMD3PN4SAPZHUJP555XQMFJJNUH3AN33UQY7FVL3H",
      ],
    },
  };
}

/** A FacilitatorClient that answers getSupported() from a locally-captured
 * snapshot instead of a live network call, so x402ResourceServer.initialize()
 * (invoked by paymentMiddleware on every buildServer() call) doesn't hit the
 * real facilitator in tests. verify()/settle() reject: no test here exercises
 * a real paid request, so a call reaching them signals a test that needs a
 * different seam (e.g. a signed test payment), not this fake. */
export function fakeFacilitatorClient(): FacilitatorClient {
  return {
    async getSupported() {
      return capturedSupportedResponse();
    },
    async verify() {
      throw new Error(
        "fakeFacilitatorClient: verify() is not supported — inject a real client to test payment.",
      );
    },
    async settle() {
      throw new Error(
        "fakeFacilitatorClient: settle() is not supported — inject a real client to test payment.",
      );
    },
  };
}

/** Hard limit on concurrent in-flight build jobs per contractId (issue #534). */
export const MAX_INFLIGHT_JOBS_PER_CONTRACT = 1;

async function findActiveRecordForContract(
  records: VerificationRepository,
  contractId: string,
): Promise<VerificationRecordInternal | undefined> {
  const history = await records.findByContract(contractId);
  return history.find((r) => r.status === "submitted" || r.status === "building");
}

export function buildServer(deps: VerificationServiceDeps = {}): FastifyInstance {
  const records = deps.records ?? createMemoryVerificationRepository();
  const queue = deps.queue ?? createNoopBuildJobQueue();
  const now = deps.now ?? (() => new Date());
  const maxActiveQueue = deps.maxActiveQueue ?? 1000;

  // Per-contractId in-flight submission tracker (issue #534): closes the async
  // check-then-insert race when multiple submissions for the same contractId
  // arrive in the same event-loop tick (e.g. Promise.all) before records.insert
  // completes.
  const inFlightByContract = new Map<string, Promise<VerificationRecordInternal | null>>();

  const app = Fastify({ logger: true });
  registerTracing(app, "verification-service");
  registerHealth(app, "verification-service");
  registerMetrics(app, "verification-service");

  // POST /verification/submit — record the submission and enqueue a build job.
  app.post("/verification/submit", async (request, reply) => {
    const parsed = submitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const input = parsed.data;

    const existingInFlight = inFlightByContract.get(input.contractId);
    if (existingInFlight) {
      const inFlightRecord = await existingInFlight;
      if (inFlightRecord) {
        return reply.code(409).send({
          error: "verification_in_progress",
          message: "A verification for this contract is already in progress.",
          status: inFlightRecord.status,
          recordId: inFlightRecord.id,
          record: toPublic(inFlightRecord),
        });
      }
    }

    let resolveInFlight!: (record: VerificationRecordInternal | null) => void;
    const inFlightPromise = new Promise<VerificationRecordInternal | null>((resolve) => {
      resolveInFlight = resolve;
    });
    inFlightByContract.set(input.contractId, inFlightPromise);

    let settled = false;
    const settleInFlight = (record: VerificationRecordInternal | null) => {
      if (!settled) {
        settled = true;
        resolveInFlight(record);
      }
    };

    try {
      // Queue-depth cap (M7): this is the last unmetered unauthenticated write path
      // after the funding-path budgets, so the cap is a real control. Reject before
      // inserting anything so a flood cannot grow the table unbounded.
      if ((await records.countActive()) >= maxActiveQueue) {
        settleInFlight(null);
        return reply.code(429).send({
          error: "queue_full",
          message: "Verification queue is at capacity; try again later.",
        });
      }
      // Per-contractId dedup (M7 / #534): one active verification per contract, so a
      // single contractId can't be used to flood the shared queue with duplicates.
      if (await records.hasActiveForContract(input.contractId)) {
        const activeRecord = await findActiveRecordForContract(records, input.contractId);
        settleInFlight(activeRecord ?? null);
        return reply.code(409).send({
          error: "verification_in_progress",
          message: "A verification for this contract is already in progress.",
          status: activeRecord?.status ?? "submitted",
          ...(activeRecord
            ? {
                recordId: activeRecord.id,
                record: toPublic(activeRecord),
              }
            : {}),
        });
      }

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
        traceId: request.traceContext?.traceId,
        traceParentSpanId: request.traceContext?.spanId,
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
          traceId: record.traceId,
          traceParentSpanId: record.traceParentSpanId,
        });
      } catch (err) {
        request.log.error({ err, recordId: record.id }, "failed to enqueue build job");
      }

      settleInFlight(record);
      return reply.code(201).send({ record: toPublic(record) });
    } finally {
      settleInFlight(null);
      inFlightByContract.delete(input.contractId);
    }
  });

  // GET /verification/:contractId — full verification history for a contract.
  // --- Vellar x402: payment gate for GET /verification/:contractId ---
  // payTo is read from the "vellar-x402.payToAddress" VS Code setting at runtime.
  const PAYMENT_CONFIG = {
    payToAddress: "GBBA3HN2PNOAJGR6R5VY34SQFDFTZFQIGDPYATJB34UXXFUHVR4KZRAZ",
  };

  // @x402/fastify derives the published resource.url from the INBOUND
  // request's Host header when no explicit `resource` is given — behind
  // api-gateway's proxy (which doesn't rewrite Host) that's this service's
  // own internal bind address, not a public one. This exact defect published
  // "localhost:4002" for /lifecycle/execute to the public mainnet Bazaar
  // catalog before it was caught (see docs/decisions.md); this route uses
  // the identical mechanism and would repeat it the moment it's registered.
  // publicBaseUrlFromEnv() throws and refuses to boot rather than silently
  // publishing an unreachable URL.
  const x402PublicResourceUrl = `${publicBaseUrlFromEnv()}/verification/:contractId`;

  const x402FacilitatorClient =
    deps.x402FacilitatorClient ??
    new HTTPFacilitatorClient({ url: "https://vellar-facilitator.onrender.com" });
  const x402Server = new x402ResourceServer(x402FacilitatorClient)
    .register("stellar:pubnet", new ExactStellarScheme())
    .registerExtension(bazaarResourceServerExtension);

  const x402Routes = {
    "GET /verification/:contractId": {
      resource: x402PublicResourceUrl,
      accepts: {
        scheme: "exact" as const,
        price: "$0.05",
        network: "stellar:pubnet" as const,
        payTo: PAYMENT_CONFIG.payToAddress,
        maxTimeoutSeconds: 300,
      },
      description:
        "Returns the full contract-verification history (reproducible-build source-verification records) for a Soroban contract.",
      serviceName: "@vellar/verification-service",
      tags: ["api", "x402", "stellar", "contract-verification"],
      extensions: declareDiscoveryExtension({
        pathParams: {
          contractId: "CAQDNEHYHTNCGJN5HBS7L7NVIV7LM6HIKXNFDAM7ZLLJFNLAT4QVJKACAAAA",
        },
        pathParamsSchema: {
          properties: {
            contractId: {
              type: "string",
              description: "Soroban contract address (C...) to look up verification history for",
            },
          },
        },
        output: {
          example: {
            contractId: "CAQDNEHYHTNCGJN5HBS7L7NVIV7LM6HIKXNFDAM7ZLLJFNLAT4QVJKACAAAA",
            records: [
              {
                id: "rec_01HXYZ",
                status: "verified",
                sourceType: "repo",
                repoUrl: "https://github.com/org/contract",
                commitHash: "a1b2c3d",
                toolchainVersion: "1.81.0",
                statusDetail: "Build reproduced; WASM hash matches on-chain contract.",
                createdAt: "2026-09-01T12:00:00.000Z",
                updatedAt: "2026-09-01T12:03:00.000Z",
              },
            ],
          },
        },
      }),
    },
  };
  // --- end Vellar x402 setup ---
  // Validate the contractId BEFORE the payment gate. Fastify runs onRequest
  // hooks in registration order, so this hook (registered ahead of
  // paymentMiddleware) rejects a malformed id with 400 before the caller is
  // asked to pay — or charged — for a request that can only ever fail.
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "GET" || request.routeOptions.url !== "/verification/:contractId") {
      return;
    }
    const parsed = contractIdSchema.safeParse(
      (request.params as { contractId?: string }).contractId,
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_contract_id" });
    }
  });
  paymentMiddleware(app, x402Routes, x402Server); // Vellar x402: gate the route below
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
 * the public record is the @vellar/types shape plus the build log. */
// Exported so the redaction guarantee (H3/FIX 6) can be unit-tested directly:
// the /verification/:contractId route is x402-gated, so an unauthenticated
// test request can no longer reach this function through the HTTP layer.
export function toPublic(
  record: VerificationRecordInternal,
): VerificationRecord & { statusDetail?: string } {
  // Strip the internal fields AND the private `log` (H3/FIX 6): only the
  // sanitized statusDetail is safe to return unauthenticated.
  const {
    sourceArchiveRef: _ref,
    lockfileHash: _lock,
    log: _log,
    traceId: _traceId,
    traceParentSpanId: _traceParent,
    ...pub
  } = record;
  return pub;
}
