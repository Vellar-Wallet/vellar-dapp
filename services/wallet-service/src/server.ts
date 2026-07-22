import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { registerHealth, registerMetrics, domainMetrics, recordOutcome } from "@vela/service-kit";
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

export interface WalletServiceDeps {
  submitter: TransactionSubmitter;
  wallets?: WalletRepository;
  sessions?: SessionRepository;
  audit?: AuditLog;
  now?: () => Date;
}

export function buildServer(deps: WalletServiceDeps): FastifyInstance {
  const wallets = deps.wallets ?? createMemoryWalletRepository();
  const sessions = deps.sessions ?? createMemorySessionRepository();
  const audit = deps.audit ?? createMemoryAuditLog();
  const now = deps.now ?? (() => new Date());
  const { submitter } = deps;

  const app = Fastify({ logger: true });
  registerHealth(app, "wallet-service");
  registerMetrics(app, "wallet-service");

  async function openSession(contractId: string, network: "testnet" | "mainnet") {
    const timestamp = now().toISOString();
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      contractId,
      network,
      createdAt: timestamp,
      lastActiveAt: timestamp,
    };
    await sessions.insert(record);
    return record;
  }

  app.post("/wallet/create", async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { keyId, contractId, network, signedTx } = parsed.data;

    if (await wallets.findByKeyId(keyId, network)) {
      return reply.code(409).send({ error: "wallet_exists" });
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
    await audit.record("wallet.created", { contractId, network, txHash: hash });
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
      recordOutcome(domainMetrics.passkeyAuth, "wallet-service", "failure", network);
      return reply.code(404).send({ error: "wallet_not_found" });
    }

    const session = await openSession(wallet.contractId, network);
    await audit.record("wallet.connected", { contractId: wallet.contractId, network });
    recordOutcome(domainMetrics.passkeyAuth, "wallet-service", "success", network);
    return reply.send({ contractId: wallet.contractId, sessionId: session.id });
  });

  app.post("/wallet/submit", async (request, reply) => {
    const parsed = submitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { signedXdr, network } = parsed.data;

    try {
      const { hash } = await submitter.submit(signedXdr);
      await audit.record("tx.submitted", { network, txHash: hash });
      recordOutcome(domainMetrics.txSigned, "wallet-service", "success", network);
      return reply.send({ hash });
    } catch (err) {
      const sub = err instanceof SubmissionError ? err : undefined;
      request.log.error(err, "transaction submission failed");
      recordOutcome(domainMetrics.txSigned, "wallet-service", "failure", network);
      // Submission goes through the relayer/RPC path — a failure here is also an
      // RPC-degradation signal (§13 alerting: tx submission spikes/failures).
      domainMetrics.rpcErrors.inc({ service: "wallet-service", upstream: "relayer" });
      return reply.code(502).send({
        error: sub?.code ?? "submission_failed",
        message: sub?.message ?? "Transaction submission failed",
      });
    }
  });

  app.get("/wallet/session/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await sessions.find(id);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    return reply.send(session);
  });

  // Session/device management (technical-doc.md §5.1: users can manage
  // active sessions/devices).
  app.get("/wallet/sessions", async (request, reply) => {
    const parsed = listSessionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.issues });
    }
    const { contractId, network } = parsed.data;
    return reply.send({ sessions: await sessions.listByContract(contractId, network) });
  });

  app.delete("/wallet/session/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await sessions.find(id);
    if (!existing) return reply.code(404).send({ error: "session_not_found" });
    await sessions.delete(id);
    await audit.record("session.revoked", {
      sessionId: id,
      contractId: existing.contractId,
      network: existing.network,
    });
    return reply.code(204).send();
  });

  return app;
}
