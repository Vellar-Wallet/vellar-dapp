import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  registerHealth,
  registerMetrics,
  registerCorrelationId,
  domainMetrics,
  recordOutcome,
  type SpendBudget,
  type BudgetNetwork,
  registerTracing,
} from "@vellar/service-kit";
import {
  createMemoryAuditLog,
  createMemorySessionRepository,
  createMemoryWalletRepository,
  DuplicateWalletError,
  type AuditLog,
  type SessionRecord,
  type SessionRepository,
  type WalletRepository,
} from "./repository";
import { SubmissionError, type TransactionSubmitter } from "./relayer";
import { assertScopedToKnownWallets, extractAddressAuthSubjects, ScopeError } from "./scope";
import {
  createMemoryReplayGuard,
  extractReplayKeys,
  RELEASABLE_SUBMISSION_CODES,
  replayFingerprint,
  type ReplayGuard,
  type ReplayKey,
  type ReserveResult,
} from "./replay";
import { assertDerivedContractId, DerivationMismatchError } from "./derivation";
import { initCacheMetrics, type CacheOperation } from "./cache-metrics";
import { NoOpCache } from "./cache";
import { createMemoryInFlightTracker, type InFlightTracker } from "./in-flight";
import { buildMergePlan, type MergeBalance } from "./merge-planner";

// Wallet API (idea.md §11). No POST /wallet/sign: signing is client-side via
// passkeys by design (technical-doc.md §8 — no silent signing, no server key
// custody); see docs/decisions.md.

const networkSchema = z.enum(["testnet", "mainnet"]);

const createBodySchema = z.object({
  keyId: z.string().min(1),
  contractId: z.string().min(1),
  network: networkSchema,
  signedTx: z.string().min(1),
});

const connectBodySchema = z.object({
  keyId: z.string().min(1),
  network: networkSchema,
});

const submitBodySchema = z.object({
  signedXdr: z.string().min(1),
  network: networkSchema,
});

const listSessionsQuerySchema = z.object({
  contractId: z.string().min(1),
  network: networkSchema,
});

// Issue #256: cursor-based pagination for GET /wallet/transactions. limit is
// capped (not just defaulted) server-side — the query schema alone cannot
// express "clamp to a max", so DEFAULT_TX_HISTORY_LIMIT/MAX_TX_HISTORY_LIMIT
// below do that after parsing.
const DEFAULT_TX_HISTORY_LIMIT = 20;
const MAX_TX_HISTORY_LIMIT = 100;
const listTransactionsQuerySchema = z.object({
  contractId: z.string().min(1),
  network: networkSchema,
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
  status: z.enum(["submitted", "failed", "policy-rejected"]).optional(),
});

const revokeSessionBodySchema = z.object({
  targetSessionId: z.string().min(1),
});

// A session id is a BEARER CAPABILITY for the session routes (security-audit.md
// RA-3/M1): possession authorizes listing/reading/revoking sessions for the
// account that session is bound to — nothing else. It expires on a 7-day sliding
// window, matching the device signer's 7-day expiry (apps/extension L4); if one
// lifetime changes, change both. It is NOT a general auth token: no other route
// reads it, and it never grants signing or funding authority (those are on-chain
// via __check_auth).
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A non-reversible reference to a session id for the audit log — the raw id is
 * a credential and must not be written to storage in plaintext. */
function sessionRef(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

/** The bearer session id from the Authorization header, or undefined. */
function bearerSessionId(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export interface SubmissionDedupStore {
  get(hash: string): Promise<{ hash: string } | undefined> | { hash: string } | undefined;
  set(hash: string, result: { hash: string }): Promise<void> | void;
}

export type JobStatus = "queued" | "building" | "stuck" | "completed" | "failed";

export interface WalletJobRecord {
  recordId: string;
  contractId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  sourceType?: string;
  toolchainVersion?: string;
  [key: string]: unknown;
}

export interface WalletServiceDeps {
  submitter: TransactionSubmitter;
  wallets?: WalletRepository;
  sessions?: SessionRepository;
  audit?: AuditLog;
  cache?: CacheOperation;
  submissionDedup?: SubmissionDedupStore;
  jobStuckThresholdMs?: number;
  now?: () => Date;
  /** Passphrase used to parse submitted XDR for funding-path scoping. Keyed off
   * server config, NEVER the request body's network field (security-audit V5).
   * When unset, submission scoping is disabled (dev/no-relayer). */
  networkPassphrase?: string;
  /** Readiness probe for DB-aware /health (FIX 7). Returns false when the
   * persistence layer is degraded so the orchestrator stops routing. */
  isReady?: () => boolean | Promise<boolean>;
  /** Rolling-window spend budget for the "create" funding line (FIX 3). When
   * set, /wallet/create consumes it before relayer-funding a deploy; a refusal
   * returns 503. Unset = budgeting disabled (dev / no relayer). The sponsor
   * line is metered inside the submitter, where the fee is known. */
  budget?: SpendBudget;
  /** Network label for the create budget ledger line — from SERVER CONFIG
   * (resolveNetwork), NEVER the request body's network field (security-audit
   * V5/RA-3). Required alongside `budget`; without it the create route cannot
   * meter (fails closed). Metering on the body would let a caller split spend
   * across the testnet/mainnet partitions and double the effective ceiling. */
  budgetNetwork?: BudgetNetwork;
  /** Replay reservations for /wallet/submit (issue #416). Defaults to an
   * in-memory guard; index.ts wires the Postgres guard when durable. Applied
   * whenever `networkPassphrase` is set (the same condition as scoping). */
  replayGuard?: ReplayGuard;
  passkeyRateLimitMax?: number;
  passkeyRateLimitWindowMs?: number;
  /** In-flight tracker for active submissions (issue #510). */
  inFlightTracker?: InFlightTracker;
  /** Optional job enqueuer for worker-service jobs (Issue #299). */
  jobQueue?: {
    enqueue(job: {
      recordId: string;
      contractId: string;
      correlationId?: string;
      [key: string]: unknown;
    }): Promise<void>;
    get?(recordId: string): Promise<WalletJobRecord | undefined> | WalletJobRecord | undefined;
    updateStatus?(recordId: string, status: JobStatus): Promise<void> | void;
  };
  /** Base URL for verification-service (defaults to process.env.VERIFICATION_SERVICE_URL ?? "http://localhost:4002"). */
  verificationServiceUrl?: string;
  /** Verification lookup client seam for testing or in-process verification. */
  verificationClient?: {
    getStatus(contractId: string): Promise<{ status: string }>;
  };
  /** In-memory or persistent store for signer set versions for OCC guard (Issue #509). */
  signerVersions?: Map<string, number>;
}

export function buildServer(deps: WalletServiceDeps): FastifyInstance {
  const wallets = deps.wallets ?? createMemoryWalletRepository();
  const sessions = deps.sessions ?? createMemorySessionRepository();
  const audit = deps.audit ?? createMemoryAuditLog();
  const cache = deps.cache ?? new NoOpCache();
  const replayGuard = deps.replayGuard ?? createMemoryReplayGuard();
  const inFlightTracker = deps.inFlightTracker ?? createMemoryInFlightTracker();
  const now = deps.now ?? (() => new Date());
  const { submitter } = deps;
  const signerVersions = deps.signerVersions ?? new Map<string, number>();

  const memorySubmissionDedup = new Map<string, { hash: string }>();
  const submissionDedup: SubmissionDedupStore = deps.submissionDedup ?? {
    get: (h: string) => memorySubmissionDedup.get(h),
    set: (h: string, res: { hash: string }) => {
      memorySubmissionDedup.set(h, res);
    },
  };

  const memoryJobs = new Map<string, WalletJobRecord>();
  const jobStuckThresholdMs = deps.jobStuckThresholdMs ?? 5 * 60 * 1000;

  const connectRateLimits = new Map<string, { count: number; resetAt: number }>();
  const passkeyRateLimitMax = deps.passkeyRateLimitMax ?? 5;
  const passkeyRateLimitWindowMs = deps.passkeyRateLimitWindowMs ?? 60_000;

  const app = Fastify({ logger: true });
  registerTracing(app, "wallet-service");
  registerHealth(app, "wallet-service", { isReady: deps.isReady });
  registerMetrics(app, "wallet-service");
  initCacheMetrics();
  registerCorrelationId(app);

  async function openSession(contractId: string, network: "testnet" | "mainnet") {
    const at = now();
    const timestamp = at.toISOString();
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      contractId,
      network,
      createdAt: timestamp,
      lastActiveAt: timestamp,
      expiresAt: new Date(at.getTime() + SESSION_TTL_MS).toISOString(),
    };
    await sessions.insert(record);
    return record;
  }

  /** Resolve the caller's live session capability from the bearer, or undefined
   * when there is no header, the id is unknown, or the session has expired (an
   * expired session is ABSENT — no response distinguishes it from a bogus id).
   * On success it SLIDES the session forward (lastActiveAt + expiresAt), so only
   * an authorized use extends its life; a rejected id cannot. */
  async function resolveSessionCapability(
    request: FastifyRequest,
  ): Promise<SessionRecord | undefined> {
    const id = bearerSessionId(request);
    if (!id) return undefined;
    const at = now();
    const session = await sessions.find(id, at);
    if (!session) return undefined;
    await sessions.touch(id, at, new Date(at.getTime() + SESSION_TTL_MS));
    return session;
  }

  app.post("/wallet/create", async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { keyId, contractId, network, signedTx } = parsed.data;

    // Derivation gate (security-audit.md V1): the smart-account address is a
    // secret-free pure function of the keyId, so a caller must not be able to
    // map their keyId to a contractId that isn't derive(keyId). This closes
    // /wallet/create as a third funding path and enforces the invariant the
    // keyId "client-authoritative" property rests on. Passphrase from server
    // config, never the request body (V5).
    if (deps.networkPassphrase) {
      try {
        assertDerivedContractId(keyId, contractId, {
          networkPassphrase: deps.networkPassphrase,
        });
      } catch (err) {
        if (err instanceof DerivationMismatchError) {
          request.log.warn({ code: err.code }, "rejected create with mismatched contractId");
          recordOutcome(domainMetrics.walletCreated, "wallet-service", "failure", network);
          return reply.code(403).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    }

    if (await wallets.findByKeyId(keyId, network)) {
      return reply.code(409).send({ error: "wallet_exists" });
    }

    // Meter wallet creation on its own budget line (FIX 3): creation is
    // relayer-funded and unauthenticated, so cap it separately from submit so
    // create-spam can't drain the budget legitimate submits need. Count-only
    // (relayer quota isn't server-held XLM). Fails CLOSED — a refusal or an
    // accounting error blocks the create rather than funding it unmetered.
    if (deps.budget) {
      let allowed: boolean;
      try {
        // Meter on the SERVER-CONFIG network (V5/RA-3), never the request body:
        // a body-keyed line would let a caller split spend across the
        // testnet/mainnet partitions and double the effective ceiling. Fail
        // closed if budgetNetwork wasn't wired alongside the budget.
        if (!deps.budgetNetwork) throw new Error("budget configured without budgetNetwork");
        const r = await deps.budget.tryConsume({
          line: "create",
          network: deps.budgetNetwork,
          stroops: 0n,
        });
        allowed = r.ok;
      } catch (err) {
        request.log.error(err, "create budget accounting failed; refusing");
        allowed = false;
      }
      if (!allowed) {
        recordOutcome(domainMetrics.walletCreated, "wallet-service", "failure", network);
        return reply.code(503).send({
          error: "create_budget_exceeded",
          message: "Wallet-creation budget reached; try again later.",
        });
      }
    }

    // Submit before persisting: a stored mapping to an undeployed contract
    // would make reconnect resolve to a dead account.
    let hash: string;
    try {
      ({ hash } = await submitter.submit(signedTx));
    } catch (err) {
      const sub = err instanceof SubmissionError ? err : undefined;
      request.log.error(err, "wallet deployment submission failed");
      recordOutcome(domainMetrics.walletCreated, "wallet-service", "failure", network);
      return reply.code(502).send({
        error: sub?.code ?? "submission_failed",
        message: sub?.message ?? "Transaction submission failed",
      });
    }

    await wallets.insert({ keyId, contractId, network, createdAt: now().toISOString() });
    const session = await openSession(contractId, network);
    await audit.record("wallet.created", {
      contractId,
      network,
      txHash: hash,
      correlationId: request.correlationId,
    });
    recordOutcome(domainMetrics.walletCreated, "wallet-service", "success", network);
    return reply.code(201).send({ contractId, sessionId: session.id, txHash: hash });
  });

  app.post("/wallet/connect", async (request, reply) => {
    const parsed = connectBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { keyId, network } = parsed.data;

    const ip = request.ip || "127.0.0.1";
    const rateKey = `${ip}:${keyId}`;
    const currentTime = now().getTime();
    let record = connectRateLimits.get(rateKey);
    if (!record || currentTime > record.resetAt) {
      record = { count: 1, resetAt: currentTime + passkeyRateLimitWindowMs };
      connectRateLimits.set(rateKey, record);
    } else {
      record.count += 1;
    }

    if (record.count > passkeyRateLimitMax) {
      recordOutcome(domainMetrics.passkeyAuth, "wallet-service", "failure", network);
      recordOutcome(domainMetrics.passkeyAuthRateLimited, "wallet-service", "failure", network);
      return reply
        .code(429)
        .header("retry-after", Math.ceil((record.resetAt - currentTime) / 1000))
        .send({
          error: "rate_limited",
          message:
            "Too many authentication attempts for this account or IP. Please try again later.",
        });
    }

    const wallet = await wallets.findByKeyId(keyId, network);
    if (!wallet) {
      recordOutcome(domainMetrics.walletPasskeyAuth, "wallet-service", "failure", network);
      return reply.code(404).send({ error: "wallet_not_found" });
    }

    const session = await openSession(wallet.contractId, network);
    await audit.record("wallet.connected", {
      contractId: wallet.contractId,
      network,
      correlationId: request.correlationId,
    });
    recordOutcome(domainMetrics.walletPasskeyAuth, "wallet-service", "success", network);
    return reply.send({ contractId: wallet.contractId, sessionId: session.id });
  });

  app.post("/wallet/submit", async (request, reply) => {
    const parsed = submitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { signedXdr, network } = parsed.data;

    // Idempotent replay detection keyed on the signed XDR hash (Issue #515).
    // The signed XDR is a tamper-proof dedup key. Repeated identical envelopes
    // return the cached submission result instead of resubmitting or triggering
    // replay rejection.
    const envelopeHash = createHash("sha256").update(signedXdr).digest("hex");
    const cachedSubmission = await submissionDedup.get(envelopeHash);
    if (cachedSubmission) {
      request.log.info(
        { envelopeHash, hash: cachedSubmission.hash },
        "returning existing submission result for idempotent replay",
      );
      recordOutcome(domainMetrics.walletTxSigned, "wallet-service", "success", network);
      return reply.send(cachedSubmission);
    }

    // Address-credential auth subjects (the wallet contractId(s) this tx acts
    // on behalf of), extracted once and reused for both the scoping check
    // below and the tx history audit record (issue #256), so a submitted tx
    // shows up under GET /wallets/:id/transactions for its owning wallet.
    // Independent of the networkPassphrase gate: history should not silently
    // stop working just because that guard happens to be disabled.
    const walletSubjects = deps.networkPassphrase
      ? extractAddressAuthSubjects(signedXdr, deps.networkPassphrase)
      : [];

    const releases = walletSubjects.map((subject) => inFlightTracker.start(subject));

    try {
      // Scope BOTH funding paths (sponsor + relayer) at the route, before the
      // submitter picks a branch (security-audit.md C1/H1/V2): only sponsor/relay
      // a tx whose address-credential auth subjects are all wallets we created.
      // The passphrase comes from server config, never the request body (V5).
      if (deps.networkPassphrase) {
        try {
          await assertScopedToKnownWallets(signedXdr, deps.networkPassphrase, (contractId) =>
            wallets.existsByContractId(contractId, network),
          );
        } catch (err) {
          if (err instanceof ScopeError) {
            request.log.warn({ code: err.code }, "rejected unscoped submission");
            for (const contractId of walletSubjects) {
              await audit.record(
                "tx.policy_rejected",
                {
                  network,
                  reason: err.message,
                  code: err.code,
                  correlationId: request.correlationId,
                },
                contractId,
              );
            }
            recordOutcome(domainMetrics.walletTxSigned, "wallet-service", "failure", network);
            return reply.code(403).send({ error: err.code, message: err.message });
          }
          // A repository error here means we cannot verify the tx is scoped to a
          // known wallet (e.g. Postgres dropped mid-run). Fail CLOSED — refuse to
          // sponsor/relay rather than degrade to unmetered submission (FIX 7).
          request.log.error(err, "scoping check failed; refusing submission");
          recordOutcome(domainMetrics.walletTxSigned, "wallet-service", "failure", network);
          return reply.code(503).send({
            error: "persistence_unavailable",
            message: "Cannot verify wallet scope right now; try again shortly.",
          });
        }
      }

      // Replay reservation (issue #416), AFTER scoping (so unknown-wallet junk
      // cannot fill the table) and BEFORE the submitter — i.e. before simulation,
      // budget consumption, signing, or send. Keyed on each address-credential
      // auth entry's (address, nonce), which survives any re-wrapping of the
      // envelope; see src/replay.ts. Fails CLOSED on a storage error.
      let replayKeys: ReplayKey[] = [];
      if (deps.networkPassphrase) {
        replayKeys = extractReplayKeys(signedXdr, deps.networkPassphrase);
        let reserved: ReserveResult;
        try {
          reserved = await replayGuard.reserve(replayKeys);
        } catch (err) {
          request.log.error(err, "replay reservation failed; refusing submission");
          recordOutcome(domainMetrics.walletTxSigned, "wallet-service", "failure", network);
          return reply.code(503).send({
            error: "replay_store_unavailable",
            message: "Cannot record this submission right now; try again shortly.",
          });
        }
        if (!reserved.ok) {
          const fingerprint = replayFingerprint(replayKeys);
          request.log.warn({ fingerprint }, "rejected replayed submission");
          // Audit the rejection with the credential subjects and a key-set
          // fingerprint only — never the signed XDR or signatures. A failed audit
          // write does not turn a rejection into an acceptance.
          try {
            await audit.record("tx.replay_rejected", {
              network,
              subjects: [...new Set(replayKeys.map((k) => k.address))],
              fingerprint,
              correlationId: request.correlationId,
            });
          } catch (err) {
            request.log.error(err, "failed to audit replay rejection");
          }
          recordOutcome(domainMetrics.walletTxSigned, "wallet-service", "failure", network);
          return reply.code(409).send({
            error: "replayed_submission",
            message: "This signed authorization has already been submitted.",
          });
        }
      }

      try {
        const { hash } = await submitter.submit(signedXdr);
        await submissionDedup.set(envelopeHash, { hash });

        // Invalidate balance cache entry for affected wallets after confirmed submission (#520)
        for (const contractId of walletSubjects) {
          if (typeof cache.invalidateBalance === "function") {
            await cache.invalidateBalance(contractId);
          } else {
            await cache.delete("balance", contractId);
          }
        }

        // One audit row per wallet subject: a tx with two address-credential
        // subjects (rare, but the type allows it) must show up in BOTH wallets'
        // history, not just the first.
        for (const contractId of walletSubjects) {
          await audit.record(
            "tx.submitted",
            { network, txHash: hash, correlationId: request.correlationId },
            contractId,
          );
        }
        if (walletSubjects.length === 0) {
          // No address-credential subject (e.g. networkPassphrase unset) — still
          // record the event, just without wallet attribution, matching prior
          // behavior exactly.
          await audit.record("tx.submitted", {
            network,
            txHash: hash,
            correlationId: request.correlationId,
          });
        }
        recordOutcome(domainMetrics.walletTxSigned, "wallet-service", "success", network);
        return reply.send({ hash });
      } catch (err) {
        const sub = err instanceof SubmissionError ? err : undefined;
        request.log.error(err, "transaction submission failed");
        const eventType =
          sub?.code === "policy_rejected" || sub?.code === "policy_violation"
            ? "tx.policy_rejected"
            : "tx.failed";
        for (const contractId of walletSubjects) {
          await audit.record(
            eventType,
            {
              network,
              error: sub?.code ?? "submission_failed",
              message: sub?.message ?? "Transaction submission failed",
              correlationId: request.correlationId,
            },
            contractId,
          );
        }
        if (walletSubjects.length === 0) {
          await audit.record(eventType, {
            network,
            error: sub?.code ?? "submission_failed",
            message: sub?.message ?? "Transaction submission failed",
            correlationId: request.correlationId,
          });
        }
        // Release only when the failure provably preceded any send; otherwise the
        // nonce may be spent on-chain and a retry must be a fresh signature.
        if (replayKeys.length > 0 && sub && RELEASABLE_SUBMISSION_CODES.has(sub.code)) {
          await replayGuard.release(replayKeys).catch((releaseErr: unknown) => {
            request.log.error(releaseErr, "failed to release replay reservation");
          });
        }
        recordOutcome(domainMetrics.walletTxSigned, "wallet-service", "failure", network);
        // Submission goes through the relayer/RPC path — a failure here is also an
        // RPC-degradation signal (§13 alerting: tx submission spikes/failures).
        domainMetrics.rpcErrors.inc({ service: "wallet-service", upstream: "relayer" });
        return reply.code(502).send({
          error: sub?.code ?? "submission_failed",
          message: sub?.message ?? "Transaction submission failed",
        });
      }
    } finally {
      for (const release of releases) {
        release();
      }
    }
  });

  const jobSchema = z.object({
    recordId: z.string().min(1),
    contractId: z.string().min(1),
    sourceType: z.enum(["repo", "upload"]).default("repo"),
    toolchainVersion: z.string().default("latest"),
  });

  // Enqueue a job for worker-service with correlation ID preserved (Issue #299)
  app.post("/wallet/jobs", async (request, reply) => {
    const parsed = jobSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const correlationId = request.correlationId;
    const nowIso = now().toISOString();
    const jobRecord: WalletJobRecord = {
      recordId: parsed.data.recordId,
      contractId: parsed.data.contractId,
      sourceType: parsed.data.sourceType,
      toolchainVersion: parsed.data.toolchainVersion,
      status: "queued",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    memoryJobs.set(parsed.data.recordId, jobRecord);

    if (deps.jobQueue) {
      await deps.jobQueue.enqueue({
        ...parsed.data,
        correlationId,
        // #301: the worker continues this request's trace.
        traceId: request.traceContext?.traceId,
        traceParentSpanId: request.traceContext?.spanId,
      });
    }
    request.log.info({ correlationId, recordId: parsed.data.recordId }, "worker job enqueued");
    await audit.record("worker.job_enqueued", {
      ...parsed.data,
      correlationId,
    });
    return reply.code(202).send({
      enqueued: true,
      recordId: parsed.data.recordId,
      status: "queued",
      correlationId,
    });
  });

  function getEffectiveJobStatus(job: WalletJobRecord): JobStatus {
    if (job.status === "building") {
      const updatedAtMs = new Date(job.updatedAt).getTime();
      if (now().getTime() - updatedAtMs > jobStuckThresholdMs) {
        return "stuck";
      }
    }
    return job.status;
  }

  // Status endpoint distinguishing queued, building, and stuck states (Issue #516)
  app.get("/wallet/jobs/:recordId", async (request, reply) => {
    const { recordId } = request.params as { recordId: string };
    const job = (await deps.jobQueue?.get?.(recordId)) ?? memoryJobs.get(recordId);
    if (!job) {
      return reply.code(404).send({ error: "job_not_found" });
    }
    const status = getEffectiveJobStatus(job);
    return reply.send({
      recordId: job.recordId,
      contractId: job.contractId,
      status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });

  // Query lookup compatibility (?recordId=)
  app.get("/wallet/jobs", async (request, reply) => {
    const { recordId } = (request.query ?? {}) as { recordId?: string };
    if (!recordId) {
      return reply.code(400).send({ error: "invalid_query", message: "recordId is required" });
    }
    const job = (await deps.jobQueue?.get?.(recordId)) ?? memoryJobs.get(recordId);
    if (!job) {
      return reply.code(404).send({ error: "job_not_found" });
    }
    const status = getEffectiveJobStatus(job);
    return reply.send({
      recordId: job.recordId,
      contractId: job.contractId,
      status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });

  // Status transition endpoint for workers/tests
  app.patch("/wallet/jobs/:recordId", async (request, reply) => {
    const { recordId } = request.params as { recordId: string };
    const schema = z.object({
      status: z.enum(["queued", "building", "stuck", "completed", "failed"]),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const job = (await deps.jobQueue?.get?.(recordId)) ?? memoryJobs.get(recordId);
    if (!job) {
      return reply.code(404).send({ error: "job_not_found" });
    }
    job.status = parsed.data.status;
    job.updatedAt = now().toISOString();
    if (deps.jobQueue?.updateStatus) {
      await deps.jobQueue.updateStatus(recordId, parsed.data.status);
    }
    return reply.send({
      recordId: job.recordId,
      status: job.status,
      updatedAt: job.updatedAt,
    });
  });

  // Session/device management (technical-doc.md §5.1). Every route below is
  // gated on a bearer SESSION CAPABILITY (RA-3/M1): the caller proves control of
  // a live session on the account before reading or revoking its sessions. The
  // session id travels ONLY in the Authorization header / request body, never in
  // a URL path or query — Fastify logs request URLs but not headers/bodies, so a
  // credential must not sit in a logged URL. `unauthorized` is returned
  // identically for a missing, unknown, expired, or wrong-account bearer, so no
  // response reveals whether an id was ever valid.

  const getSessionQuerySchema = z.object({
    contractId: z.string().min(1).optional(),
  });

  // The caller's OWN session (from the bearer). No id in the URL.
  // When contractId query parameter is provided, validates that the session belongs to it.
  app.get("/wallet/session", async (request, reply) => {
    const queryParsed = getSessionQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: queryParsed.error.issues });
    }
    const session = await resolveSessionCapability(request);
    if (
      !session ||
      (queryParsed.data.contractId && session.contractId !== queryParsed.data.contractId)
    ) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send(session);
  });

  // List the sessions for an account. The bearer must be a live session bound to
  // exactly the queried contract+network — no cross-account enumeration.
  app.get("/wallet/sessions", async (request, reply) => {
    const parsed = listSessionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.issues });
    }
    const { contractId, network } = parsed.data;
    const session = await resolveSessionCapability(request);
    if (!session || session.contractId !== contractId || session.network !== network) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send({ sessions: await sessions.listByContract(contractId, network, now()) });
  });

  // Cursor-paginated transaction history for an account (issue #256). Same
  // bearer-session-capability gating as /wallet/sessions above: the bearer
  // must be a live session bound to exactly the queried contract+network, so
  // this cannot be used to enumerate another account's history. `network` is
  // NOT stored per-event today (tx.submitted's audit data carries it, but
  // filtering happens on `actor` alone), so this endpoint returns every
  // tx.submitted event for the contractId regardless of network; that is a
  // pre-existing property of how the audit trail is written, not something
  // this endpoint introduces.
  app.get("/wallet/transactions", async (request, reply) => {
    const parsed = listTransactionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.issues });
    }
    const { contractId, network, after, status } = parsed.data;
    const limit = Math.min(parsed.data.limit ?? DEFAULT_TX_HISTORY_LIMIT, MAX_TX_HISTORY_LIMIT);

    const session = await resolveSessionCapability(request);
    if (!session || session.contractId !== contractId || session.network !== network) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    let page;
    try {
      const typeFilter =
        status === "submitted"
          ? { type: "tx.submitted" }
          : status === "failed"
            ? { type: "tx.failed" }
            : status === "policy-rejected"
              ? { type: "tx.policy_rejected" }
              : { types: ["tx.submitted", "tx.failed", "tx.policy_rejected"] };

      page = await audit.listPage({ ...typeFilter, actor: contractId, limit, after });
    } catch {
      return reply
        .code(400)
        .send({ error: "invalid_cursor", message: "cursor is not a valid pagination cursor" });
    }
    return reply.send({
      transactions: page.events.map((e) => {
        const derivedStatus =
          e.type === "tx.submitted"
            ? "submitted"
            : e.type === "tx.failed"
              ? "failed"
              : e.type === "tx.policy_rejected"
                ? "policy-rejected"
                : "submitted";
        return {
          status: derivedStatus,
          at: e.at,
          ...e.data,
        };
      }),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ?? null,
    });
  });

  // Revoke a session on the caller's OWN account. The target id is in the BODY
  // (not the URL), and must belong to the same account as the bearer — a target
  // on another account reads as not-found (no cross-account revoke, and the
  // response does not confirm the target exists elsewhere).
  app.post("/wallet/sessions/revoke", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    const parsed = revokeSessionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const target = await sessions.find(parsed.data.targetSessionId, now());
    if (!target || target.contractId !== session.contractId || target.network !== session.network) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    await sessions.delete(target.id);
    // Audit the event with a HASHED reference, never the raw id (a credential).
    await audit.record(
      "session.revoked",
      {
        sessionRef: sessionRef(target.id),
        contractId: target.contractId,
        network: target.network,
      },
      session.contractId,
    );
    return reply.code(204).send();
  });

  // Policy update sensitive action endpoint
  // Issue #513: reject policy updates referencing an unverified contract ID
  app.post("/wallet/policy/update", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const schema = z.object({
      policyId: z.string().min(1),
      contractId: z.string().min(1).optional(),
      rules: z.record(z.string(), z.unknown()).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    const referencedContractId =
      parsed.data.contractId ??
      (typeof parsed.data.rules?.contractId === "string"
        ? parsed.data.rules.contractId
        : undefined) ??
      (typeof parsed.data.rules?.targetContractId === "string"
        ? parsed.data.rules.targetContractId
        : undefined);

    if (referencedContractId) {
      let isVerified = false;
      try {
        if (deps.verificationClient) {
          const res = await deps.verificationClient.getStatus(referencedContractId);
          isVerified = res?.status === "verified";
        } else {
          const baseUrl =
            deps.verificationServiceUrl ??
            process.env.VERIFICATION_SERVICE_URL ??
            "http://localhost:4002";
          const res = await fetch(
            `${baseUrl}/verification/${encodeURIComponent(referencedContractId)}/status`,
          );
          if (!res.ok) {
            if (res.status === 404) {
              isVerified = false;
            } else {
              return reply.code(503).send({
                error: "verification_service_unavailable",
                message: `Verification service returned ${res.status}`,
              });
            }
          } else {
            const data = (await res.json()) as { status?: string };
            isVerified = data?.status === "verified";
          }
        }
      } catch (err) {
        request.log.error(err, "failed to reach verification service");
        return reply.code(503).send({
          error: "verification_service_unavailable",
          message: `Verification service is unreachable while checking contract ${referencedContractId}`,
        });
      }

      if (!isVerified) {
        return reply.code(400).send({
          error: "unverified_contract",
          message: `Referenced contract ${referencedContractId} has no verification record or is unverified`,
          contractId: referencedContractId,
        });
      }
    }

    await audit.record(
      "policy.updated",
      {
        contractId: session.contractId,
        network: session.network,
        policyId: parsed.data.policyId,
        rules: parsed.data.rules ?? {},
        contractIdRef: referencedContractId,
        actor: "policy",
      },
      session.contractId,
    );

    return reply.send({ status: "updated", policyId: parsed.data.policyId });
  });

  // Account merge sensitive action endpoint
  app.post("/wallet/account/merge", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const querySchema = z.object({
      dryRun: z.coerce.boolean().optional(),
    });
    const parsedQuery = querySchema.safeParse(request.query);

    const schema = z.object({
      destinationContractId: z.string().min(1),
      dryRun: z.boolean().optional(),
      balances: z
        .array(
          z.object({
            asset: z.string().min(1),
            amount: z.string().min(1),
            isNative: z.boolean().optional(),
            hasTrustline: z.boolean().optional(),
          }),
        )
        .optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    const isDryRun =
      Boolean(parsedQuery.success && parsedQuery.data.dryRun) || Boolean(parsed.data.dryRun);
    const plan = buildMergePlan(
      session.contractId,
      parsed.data.destinationContractId,
      parsed.data.balances ?? [],
    );

    if (isDryRun) {
      return reply.send({
        status: "preview",
        dryRun: true,
        plan,
      });
    }

    if (!plan.canMerge) {
      return reply.code(400).send({
        error: "cannot_merge_with_open_trustlines",
        message:
          "Cannot merge account with active non-native balances or trustlines. These must be transferred or closed first.",
        blockers: plan.blockers,
        plan,
      });
    }

    await audit.record(
      "account.merged",
      {
        sourceContractId: session.contractId,
        destinationContractId: parsed.data.destinationContractId,
        network: session.network,
        actor: "passkey",
        plan,
      },
      session.contractId,
    );

    return reply.send({
      status: "merged",
      destination: parsed.data.destinationContractId,
      plan,
    });
  });

  // Key rotation sensitive action endpoint
  app.post("/wallet/key/rotate", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    if (inFlightTracker.hasInFlight(session.contractId)) {
      return reply.code(409).send({
        error: "in_flight_submission_conflict",
        message: "Cannot rotate key while a transaction submission is in flight for this wallet.",
      });
    }

    const schema = z.object({
      oldKeyId: z.string().min(1),
      newKeyId: z.string().min(1),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    await audit.record(
      "key.rotated",
      {
        contractId: session.contractId,
        oldKeyId: parsed.data.oldKeyId,
        newKeyId: parsed.data.newKeyId,
        network: session.network,
        actor: "passkey",
      },
      session.contractId,
    );

    return reply.send({ status: "rotated", newKeyId: parsed.data.newKeyId });
  });

  // Threshold update sensitive action endpoint
  app.post("/wallet/threshold/update", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const schema = z.object({
      threshold: z.number().int(),
      signerCount: z.number().int().min(1).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    const { threshold } = parsed.data;
    if (threshold <= 0) {
      return reply.code(400).send({
        error: "invalid_threshold",
        message: "Threshold must be greater than zero",
        threshold,
      });
    }

    let signerCount = parsed.data.signerCount;
    if (signerCount === undefined) {
      // Calculate current signer count from audit history:
      // Starts with 1 (the initial passkey/owner), plus added signers, minus removed signers.
      const logs = await audit.list({ actor: session.contractId });
      let netSigners = 1;
      for (const log of logs) {
        if (log.type === "signer.added") {
          netSigners += 1;
        } else if (log.type === "signer.removed") {
          netSigners = Math.max(1, netSigners - 1);
        }
      }
      signerCount = netSigners;
    }

    if (threshold > signerCount) {
      return reply.code(400).send({
        error: "threshold_exceeds_signers",
        message: `Threshold ${threshold} exceeds signer count ${signerCount}`,
        threshold,
        signerCount,
      });
    }

    await audit.record(
      "threshold.updated",
      {
        contractId: session.contractId,
        threshold,
        network: session.network,
        actor: "passkey",
      },
      session.contractId,
    );

    return reply.send({ status: "threshold_updated", threshold });
  });

  // Signer add/remove sensitive action endpoint
  // Issue #509: Concurrency guard against two simultaneous signer-set mutations racing
  // Client retry contract:
  // When receiving a 409 Conflict (code: "signer_version_conflict"):
  // 1. Fetch the latest signer set and note the updated version/sequence.
  // 2. Re-compute the planned mutation against the updated signer set.
  // 3. Retry POST /wallet/signer/manage providing the latest version as `expectedVersion` or `version`.
  app.post("/wallet/signer/manage", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const schema = z.object({
      action: z.enum(["add", "remove"]),
      signerKey: z.string().min(1),
      weight: z.number().optional(),
      version: z.number().int().nonnegative().optional(),
      expectedVersion: z.number().int().nonnegative().optional(),
      sequence: z.number().int().nonnegative().optional(),
      signerType: z.enum(["passkey", "device", "policy"]).optional(),
      actor: z.enum(["passkey", "device", "policy"]).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    const currentVersion = signerVersions.get(session.contractId) ?? 0;
    const expected = parsed.data.expectedVersion ?? parsed.data.version ?? parsed.data.sequence;

    if (expected !== undefined && expected !== currentVersion) {
      return reply.code(409).send({
        error: "conflict",
        code: "signer_version_conflict",
        message: `Signer set has been modified concurrently. Expected version ${expected}, but current version is ${currentVersion}. Refresh the signer set and retry with updated version.`,
        currentVersion,
      });
    }

    const newVersion = currentVersion + 1;
    signerVersions.set(session.contractId, newVersion);

    const eventType = parsed.data.action === "add" ? "signer.added" : "signer.removed";
    await audit.record(
      eventType,
      {
        contractId: session.contractId,
        signerKey: parsed.data.signerKey,
        weight: parsed.data.weight,
        network: session.network,
        version: newVersion,
        actor: parsed.data.actor ?? parsed.data.signerType ?? "device",
      },
      session.contractId,
    );

    return reply.send({
      status: "signer_updated",
      action: parsed.data.action,
      version: newVersion,
    });
  });

  // Audit logs query endpoint
  // Issue #512: actor-based filtering (passkey vs device vs policy)
  app.get("/wallet/audit-logs", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const query = request.query as { actor?: string };
    const actor = query.actor;

    if (actor !== undefined) {
      const validActors = ["passkey", "device", "policy"];
      if (!validActors.includes(actor)) {
        return reply.code(400).send({
          error: "invalid_actor",
          message: `Invalid actor filter: must be passkey, device, or policy. Received: ${actor}`,
        });
      }
    }

    const logs = await audit.list({ actor: session.contractId });
    if (!actor) {
      return reply.send({ auditLogs: logs });
    }

    const filtered = logs.filter((e) => {
      // 1. Check explicit actor on data or record actor
      const explicitActor = e.data?.actor ?? e.data?.signerType ?? e.data?.actorType;
      if (explicitActor === actor) return true;
      if (e.actor === actor) return true;

      // 2. Inferred actor by action type if not explicitly set
      if (!explicitActor || explicitActor === e.actor) {
        if (actor === "policy" && e.type.startsWith("policy.")) return true;
        if (actor === "device" && (e.type.startsWith("session.") || e.type.startsWith("signer.")))
          return true;
        if (
          actor === "passkey" &&
          (e.type.startsWith("wallet.") ||
            e.type.startsWith("key.") ||
            e.type.startsWith("threshold.") ||
            e.type.startsWith("account."))
        ) {
          return true;
        }
      }
      return false;
    });

    return reply.send({ auditLogs: filtered });
  });

  return app;
}
