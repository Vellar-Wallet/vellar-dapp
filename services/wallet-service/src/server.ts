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
import { assertScopedToKnownWallets, ScopeError } from "./scope";
import { assertDerivedContractId, DerivationMismatchError } from "./derivation";

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

export interface WalletServiceDeps {
  submitter: TransactionSubmitter;
  wallets?: WalletRepository;
  sessions?: SessionRepository;
  audit?: AuditLog;
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
  /** Optional job enqueuer for worker-service jobs (Issue #299). */
  jobQueue?: {
    enqueue(job: {
      recordId: string;
      contractId: string;
      correlationId?: string;
      [key: string]: unknown;
    }): Promise<void>;
  };
}

export function buildServer(deps: WalletServiceDeps): FastifyInstance {
  const wallets = deps.wallets ?? createMemoryWalletRepository();
  const sessions = deps.sessions ?? createMemorySessionRepository();
  const audit = deps.audit ?? createMemoryAuditLog();
  const now = deps.now ?? (() => new Date());
  const { submitter } = deps;

  const app = Fastify({ logger: true });
  registerHealth(app, "wallet-service", { isReady: deps.isReady });
  registerMetrics(app, "wallet-service");
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
    await audit.record("wallet.created", { contractId, network, txHash: hash, correlationId: request.correlationId });
    recordOutcome(domainMetrics.walletCreated, "wallet-service", "success", network);
    return reply.code(201).send({ contractId, sessionId: session.id, txHash: hash });
  });

  app.post("/wallet/connect", async (request, reply) => {
    const parsed = connectBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { keyId, network } = parsed.data;

    const wallet = await wallets.findByKeyId(keyId, network);
    if (!wallet) {
      recordOutcome(domainMetrics.walletPasskeyAuth, "wallet-service", "failure", network);
      return reply.code(404).send({ error: "wallet_not_found" });
    }

    const session = await openSession(wallet.contractId, network);
    await audit.record("wallet.connected", { contractId: wallet.contractId, network, correlationId: request.correlationId });
    recordOutcome(domainMetrics.walletPasskeyAuth, "wallet-service", "success", network);
    return reply.send({ contractId: wallet.contractId, sessionId: session.id });
  });

  app.post("/wallet/submit", async (request, reply) => {
    const parsed = submitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { signedXdr, network } = parsed.data;

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

    try {
      const { hash } = await submitter.submit(signedXdr);
      await audit.record("tx.submitted", { network, txHash: hash, correlationId: request.correlationId });
      recordOutcome(domainMetrics.walletTxSigned, "wallet-service", "success", network);
      return reply.send({ hash });
    } catch (err) {
      const sub = err instanceof SubmissionError ? err : undefined;
      request.log.error(err, "transaction submission failed");
      recordOutcome(domainMetrics.walletTxSigned, "wallet-service", "failure", network);
      // Submission goes through the relayer/RPC path — a failure here is also an
      // RPC-degradation signal (§13 alerting: tx submission spikes/failures).
      domainMetrics.rpcErrors.inc({ service: "wallet-service", upstream: "relayer" });
      return reply.code(502).send({
        error: sub?.code ?? "submission_failed",
        message: sub?.message ?? "Transaction submission failed",
      });
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
    if (deps.jobQueue) {
      await deps.jobQueue.enqueue({
        ...parsed.data,
        correlationId,
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
      correlationId,
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

  // The caller's OWN session (from the bearer). No id in the URL.
  app.get("/wallet/session", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });
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
    return reply.send({ sessions: await sessions.listByContract(contractId, network) });
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
  app.post("/wallet/policy/update", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const schema = z.object({
      policyId: z.string().min(1),
      rules: z.record(z.unknown()).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    await audit.record(
      "policy.updated",
      {
        contractId: session.contractId,
        network: session.network,
        policyId: parsed.data.policyId,
        rules: parsed.data.rules ?? {},
      },
      session.contractId,
    );

    return reply.send({ status: "updated", policyId: parsed.data.policyId });
  });

  // Account merge sensitive action endpoint
  app.post("/wallet/account/merge", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const schema = z.object({
      destinationContractId: z.string().min(1),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    await audit.record(
      "account.merged",
      {
        sourceContractId: session.contractId,
        destinationContractId: parsed.data.destinationContractId,
        network: session.network,
      },
      session.contractId,
    );

    return reply.send({ status: "merged", destination: parsed.data.destinationContractId });
  });

  // Key rotation sensitive action endpoint
  app.post("/wallet/key/rotate", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

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
      threshold: z.number().min(1),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    await audit.record(
      "threshold.updated",
      {
        contractId: session.contractId,
        threshold: parsed.data.threshold,
        network: session.network,
      },
      session.contractId,
    );

    return reply.send({ status: "threshold_updated", threshold: parsed.data.threshold });
  });

  // Signer add/remove sensitive action endpoint
  app.post("/wallet/signer/manage", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const schema = z.object({
      action: z.enum(["add", "remove"]),
      signerKey: z.string().min(1),
      weight: z.number().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    const eventType = parsed.data.action === "add" ? "signer.added" : "signer.removed";
    await audit.record(
      eventType,
      {
        contractId: session.contractId,
        signerKey: parsed.data.signerKey,
        weight: parsed.data.weight,
        network: session.network,
      },
      session.contractId,
    );

    return reply.send({ status: "signer_updated", action: parsed.data.action });
  });

  // Audit logs query endpoint
  app.get("/wallet/audit-logs", async (request, reply) => {
    const session = await resolveSessionCapability(request);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const logs = await audit.list({ actor: session.contractId });
    return reply.send({ auditLogs: logs });
  });

  return app;
}
