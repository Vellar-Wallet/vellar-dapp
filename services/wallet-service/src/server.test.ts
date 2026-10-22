import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { createMemoryAuditLog, createMemoryWalletRepository, type AuditLog } from "./repository";
import { createUnconfiguredSubmitter, SubmissionError, type TransactionSubmitter } from "./relayer";
import { buildServer } from "./server";
import { deriveWalletContractId } from "./derivation";
import { createMemoryInFlightTracker } from "./in-flight";

function workingSubmitter(): TransactionSubmitter {
  return { submit: vi.fn().mockResolvedValue({ hash: "txhash123" }) };
}

function failingSubmitter(message = "relayer rejected"): TransactionSubmitter {
  return { submit: vi.fn().mockRejectedValue(new SubmissionError(message, "relayer_error")) };
}

const createBody = {
  keyId: "key-abc",
  contractId: "CCONTRACT",
  network: "testnet",
  signedTx: "signed-deploy-xdr",
};

let app: FastifyInstance | undefined;

function build(submitter: TransactionSubmitter, audit?: AuditLog) {
  app = buildServer({ submitter, audit });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function createAndConnect(server: FastifyInstance) {
  const create = await server.inject({
    method: "POST",
    url: "/wallet/create",
    payload: createBody,
  });
  const connect = await server.inject({
    method: "POST",
    url: "/wallet/connect",
    payload: { keyId: createBody.keyId, network: "testnet" },
  });
  return {
    createSessionId: create.json().sessionId as string,
    connectSessionId: connect.json().sessionId as string,
  };
}

describe("POST /wallet/create", () => {
  it("submits deployment, persists the mapping, opens a session, and audits", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);

    const res = await server.inject({ method: "POST", url: "/wallet/create", payload: createBody });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.contractId).toBe("CCONTRACT");
    expect(body.txHash).toBe("txhash123");
    expect(body.sessionId).toMatch(/[0-9a-f-]{36}/);

    // The returned session id is the caller's capability — fetchable via the
    // bearer, not a URL path (RA-3/M1).
    const session = await server.inject({
      url: "/wallet/session",
      headers: { authorization: `Bearer ${body.sessionId}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().contractId).toBe("CCONTRACT");

    const events = await audit.list();
    expect(events.map((e) => e.type)).toContain("wallet.created");
  });

  it("rejects invalid bodies with 400", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({
      method: "POST",
      url: "/wallet/create",
      payload: { keyId: "", network: "devnet" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("rejects a duplicate passkey mapping with 409", async () => {
    const server = build(workingSubmitter());
    await server.inject({ method: "POST", url: "/wallet/create", payload: createBody });
    const res = await server.inject({ method: "POST", url: "/wallet/create", payload: createBody });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("wallet_exists");
  });

  it("returns 502 and persists nothing when submission fails", async () => {
    const server = build(failingSubmitter());
    const res = await server.inject({ method: "POST", url: "/wallet/create", payload: createBody });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "relayer_error", message: "relayer rejected" });

    // The mapping must not exist: connect should 404.
    const connect = await server.inject({
      method: "POST",
      url: "/wallet/connect",
      payload: { keyId: createBody.keyId, network: "testnet" },
    });
    expect(connect.statusCode).toBe(404);
  });

  it("fails loudly when the relayer is unconfigured", async () => {
    const server = build(createUnconfiguredSubmitter());
    const res = await server.inject({ method: "POST", url: "/wallet/create", payload: createBody });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("relayer_not_configured");
  });
});

describe("POST /wallet/connect", () => {
  it("returns the contract mapping and a fresh session", async () => {
    const server = build(workingSubmitter());
    await server.inject({ method: "POST", url: "/wallet/create", payload: createBody });

    const res = await server.inject({
      method: "POST",
      url: "/wallet/connect",
      payload: { keyId: createBody.keyId, network: "testnet" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().contractId).toBe("CCONTRACT");
    expect(res.json().sessionId).toBeTruthy();
  });

  it("404s for an unknown passkey", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({
      method: "POST",
      url: "/wallet/connect",
      payload: { keyId: "unknown", network: "testnet" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rate-limits passkey auth connect requests when max attempts exceeded (429)", async () => {
    const server = buildServer({
      submitter: workingSubmitter(),
      passkeyRateLimitMax: 2,
    });
    const payload = { keyId: "test-key-limit", network: "testnet" as const };
    const hit1 = await server.inject({ method: "POST", url: "/wallet/connect", payload });
    expect(hit1.statusCode).toBe(404);
    const hit2 = await server.inject({ method: "POST", url: "/wallet/connect", payload });
    expect(hit2.statusCode).toBe(404);
    const hit3 = await server.inject({ method: "POST", url: "/wallet/connect", payload });
    expect(hit3.statusCode).toBe(429);
    expect(hit3.json().error).toBe("rate_limited");
  });

  it("scopes the mapping by network", async () => {
    const server = build(workingSubmitter());
    await server.inject({ method: "POST", url: "/wallet/create", payload: createBody });
    const res = await server.inject({
      method: "POST",
      url: "/wallet/connect",
      payload: { keyId: createBody.keyId, network: "mainnet" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects invalid bodies with 400", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({ method: "POST", url: "/wallet/connect", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /wallet/submit", () => {
  it("submits and returns the hash, and audits", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const res = await server.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: { signedXdr: "signed-xdr", network: "testnet" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hash: "txhash123" });
    expect((await audit.list()).map((e) => e.type)).toContain("tx.submitted");
  });

  it("maps submission failure to 502", async () => {
    const server = build(failingSubmitter("tx malformed"));
    const res = await server.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: { signedXdr: "bad", network: "testnet" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe("tx malformed");
  });

  it("rejects invalid bodies with 400", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: { signedXdr: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /health readiness (FIX 7)", () => {
  it("200 when no probe is wired (dev default)", async () => {
    const server = build(workingSubmitter());
    expect((await server.inject({ url: "/health" })).statusCode).toBe(200);
  });

  it("503 when the readiness probe reports the persistence layer is down", async () => {
    app = buildServer({ submitter: workingSubmitter(), isReady: () => false });
    const res = await app.inject({ url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("unavailable");
  });
});

// Issue #329 — GET /ready: distinct from /health, so an orchestrator can gate
// traffic on readiness specifically without depending on /health's dual
// liveness+readiness shape. Backed by the same isReady probe (deps.isReady,
// wired to the DB ping in index.ts) as /health's existing FIX 7 behavior.
describe("GET /ready", () => {
  it("200 when no probe is wired (dev default)", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({ url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready", service: "wallet-service" });
  });

  it("503 when a dependency (the DB, via isReady) is unavailable", async () => {
    app = buildServer({ submitter: workingSubmitter(), isReady: () => false });
    const res = await app.inject({ url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", service: "wallet-service" });
  });

  it("503 when the readiness probe throws (e.g. a DB ping that errors)", async () => {
    app = buildServer({
      submitter: workingSubmitter(),
      isReady: async () => {
        throw new Error("connection refused");
      },
    });
    const res = await app.inject({ url: "/ready" });
    expect(res.statusCode).toBe(503);
  });
});

describe("POST /wallet/submit fails closed when scope check errors (FIX 7 mid-run)", () => {
  const PASSPHRASE = "Test SDF Network ; September 2015";
  const KNOWN_WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  function buildInvokeTx(subject: string): string {
    const account = new Account(Keypair.random().publicKey(), "0");
    const addr = Address.fromString(subject);
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: addr.toScAddress(),
          nonce: xdr.Int64.fromString("0"),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: addr.toScAddress(),
            functionName: "transfer",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });
    const op = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: addr.toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      auth: [authEntry],
    });
    return new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
      .addOperation(op)
      .setTimeout(30)
      .build()
      .toXDR();
  }

  it("returns 503 (not 500, not sponsored) when the wallet repo throws mid-run", async () => {
    const submitter = workingSubmitter();
    const wallets = createMemoryWalletRepository();
    // Simulate a dropped DB connection during the scope lookup.
    wallets.existsByContractId = async () => {
      throw new Error("connection terminated");
    };
    app = buildServer({ submitter, wallets, networkPassphrase: PASSPHRASE });
    const res = await app.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: { signedXdr: buildInvokeTx(KNOWN_WALLET), network: "testnet" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("persistence_unavailable");
    expect(submitter.submit).not.toHaveBeenCalled();
  });
});

describe("POST /wallet/create derivation gate (V1)", () => {
  const PASSPHRASE = "Test SDF Network ; September 2015";
  const KEY_ID = "AAECAwQFBgcICQoLDA0ODw";

  it("accepts a create whose contractId equals derive(keyId)", async () => {
    const derived = deriveWalletContractId(KEY_ID, { networkPassphrase: PASSPHRASE });
    app = buildServer({ submitter: workingSubmitter(), networkPassphrase: PASSPHRASE });
    const res = await app.inject({
      method: "POST",
      url: "/wallet/create",
      payload: { keyId: KEY_ID, contractId: derived, network: "testnet", signedTx: "xdr" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().contractId).toBe(derived);
  });

  it("rejects (403) a create whose contractId does not equal derive(keyId), before submission", async () => {
    const submitter = workingSubmitter();
    app = buildServer({ submitter, networkPassphrase: PASSPHRASE });
    const res = await app.inject({
      method: "POST",
      url: "/wallet/create",
      payload: {
        keyId: KEY_ID,
        contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        network: "testnet",
        signedTx: "xdr",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("contract_id_mismatch");
    expect(submitter.submit).not.toHaveBeenCalled();
  });
});

describe("POST /wallet/create budget line (FIX 3)", () => {
  const PASSPHRASE = "Test SDF Network ; September 2015";
  const KEY_ID = "AAECAwQFBgcICQoLDA0ODw";

  it("consumes the create budget and proceeds when allowed", async () => {
    const derived = deriveWalletContractId(KEY_ID, { networkPassphrase: PASSPHRASE });
    const tryConsume = vi.fn().mockResolvedValue({ ok: true });
    app = buildServer({
      submitter: workingSubmitter(),
      networkPassphrase: PASSPHRASE,
      budgetNetwork: "testnet",
      budget: { tryConsume },
    });
    const res = await app.inject({
      method: "POST",
      url: "/wallet/create",
      payload: { keyId: KEY_ID, contractId: derived, network: "testnet", signedTx: "xdr" },
    });
    expect(res.statusCode).toBe(201);
    expect(tryConsume).toHaveBeenCalledWith({ line: "create", network: "testnet", stroops: 0n });
  });

  it("meters the create budget on SERVER CONFIG network, never the request body (V5)", async () => {
    // The RA-3-class defect: create metered on parsed.data.network (the body), so
    // an attacker could POST network:"testnet" against a mainnet server and hit
    // the idle testnet budget partition — splitting spend across two ceilings.
    // Metering MUST key off deps.budgetNetwork (config), ignoring the body.
    const derived = deriveWalletContractId(KEY_ID, { networkPassphrase: PASSPHRASE });
    const tryConsume = vi.fn().mockResolvedValue({ ok: true });
    app = buildServer({
      submitter: workingSubmitter(),
      networkPassphrase: PASSPHRASE,
      budgetNetwork: "mainnet", // server is on mainnet…
      budget: { tryConsume },
    });
    const res = await app.inject({
      method: "POST",
      url: "/wallet/create",
      // …but the body claims testnet.
      payload: { keyId: KEY_ID, contractId: derived, network: "testnet", signedTx: "xdr" },
    });
    expect(res.statusCode).toBe(201);
    // Metering hit the CONFIG partition (mainnet), not the body (testnet).
    expect(tryConsume).toHaveBeenCalledWith({ line: "create", network: "mainnet", stroops: 0n });
  });

  it("returns 503 (create_budget_exceeded) and does NOT submit when the budget refuses", async () => {
    const derived = deriveWalletContractId(KEY_ID, { networkPassphrase: PASSPHRASE });
    const submitter = workingSubmitter();
    app = buildServer({
      submitter,
      networkPassphrase: PASSPHRASE,
      budget: { tryConsume: async () => ({ ok: false, reason: "budget_exceeded" }) },
    });
    const res = await app.inject({
      method: "POST",
      url: "/wallet/create",
      payload: { keyId: KEY_ID, contractId: derived, network: "testnet", signedTx: "xdr" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("create_budget_exceeded");
    expect(submitter.submit).not.toHaveBeenCalled();
  });

  it("fails closed: a budget accounting error refuses the create", async () => {
    const derived = deriveWalletContractId(KEY_ID, { networkPassphrase: PASSPHRASE });
    const submitter = workingSubmitter();
    app = buildServer({
      submitter,
      networkPassphrase: PASSPHRASE,
      budget: {
        tryConsume: async () => {
          throw new Error("db down");
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/wallet/create",
      payload: { keyId: KEY_ID, contractId: derived, network: "testnet", signedTx: "xdr" },
    });
    expect(res.statusCode).toBe(503);
    expect(submitter.submit).not.toHaveBeenCalled();
  });
});

describe("POST /wallet/submit funding-path scoping (C1/H1/V2)", () => {
  const PASSPHRASE = "Test SDF Network ; September 2015";
  const KNOWN_WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const OTHER_CONTRACT = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";

  function buildInvokeTx(subject: string): string {
    const source = Keypair.random();
    const account = new Account(source.publicKey(), "0");
    const addr = Address.fromString(subject);
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: addr.toScAddress(),
          nonce: xdr.Int64.fromString("0"),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: addr.toScAddress(),
            functionName: "transfer",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });
    const op = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: addr.toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      auth: [authEntry],
    });
    return new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
      .addOperation(op)
      .setTimeout(30)
      .build()
      .toXDR();
  }

  function buildScopedServer(submitter: TransactionSubmitter) {
    const wallets = createMemoryWalletRepository();
    app = buildServer({ submitter, wallets, networkPassphrase: PASSPHRASE });
    return { server: app, wallets };
  }

  it("submits a tx whose only auth subject is a known wallet", async () => {
    const submitter = workingSubmitter();
    const { server, wallets } = buildScopedServer(submitter);
    await wallets.insert({
      keyId: "k",
      contractId: KNOWN_WALLET,
      network: "testnet",
      createdAt: new Date().toISOString(),
    });
    const res = await server.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: { signedXdr: buildInvokeTx(KNOWN_WALLET), network: "testnet" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects (403) a tx authorizing a contract the server does not know — before the submitter runs", async () => {
    const submitter = workingSubmitter();
    const { server } = buildScopedServer(submitter);
    const res = await server.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: { signedXdr: buildInvokeTx(OTHER_CONTRACT), network: "testnet" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("unknown_wallet_subject");
    // The submitter (which would pick sponsor OR relayer) is never reached — so
    // the tx cannot be smuggled through the relayer branch either.
    expect(submitter.submit).not.toHaveBeenCalled();
  });

  it("rejects (403) a tx with no address-credential subject (nothing to attribute)", async () => {
    const submitter = workingSubmitter();
    const { server } = buildScopedServer(submitter);
    const res = await server.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: { signedXdr: "not-a-valid-xdr", network: "testnet" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("no_wallet_subject");
    expect(submitter.submit).not.toHaveBeenCalled();
  });
});

describe("session management (§5.1) — bearer capability (RA-3/M1)", () => {
  const bearer = (id: string) => ({ authorization: `Bearer ${id}` });

  it("create/connect return a session id the client can present as a capability", async () => {
    const server = build(workingSubmitter());
    const { createSessionId, connectSessionId } = await createAndConnect(server);
    expect(createSessionId).toMatch(/[0-9a-f-]{36}/);
    expect(connectSessionId).toMatch(/[0-9a-f-]{36}/);
  });

  it("lists sessions ONLY with a valid bearer bound to that contract+network", async () => {
    const server = build(workingSubmitter());
    const { createSessionId, connectSessionId } = await createAndConnect(server);

    // No bearer -> 401 (was previously an open enumeration endpoint).
    const noAuth = await server.inject({
      url: "/wallet/sessions?contractId=CCONTRACT&network=testnet",
    });
    expect(noAuth.statusCode).toBe(401);

    // Valid bearer for this account -> 200 with the account's sessions.
    const ok = await server.inject({
      url: "/wallet/sessions?contractId=CCONTRACT&network=testnet",
      headers: bearer(createSessionId),
    });
    expect(ok.statusCode).toBe(200);
    const ids = ok.json().sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(createSessionId);
    expect(ids).toContain(connectSessionId);
  });

  it("rejects a bearer for a DIFFERENT contract than the one queried (no cross-account read)", async () => {
    const server = build(workingSubmitter());
    const { createSessionId } = await createAndConnect(server);
    const res = await server.inject({
      url: "/wallet/sessions?contractId=COTHER&network=testnet",
      headers: bearer(createSessionId),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown/garbage bearer with 401 (never 500)", async () => {
    const server = build(workingSubmitter());
    await createAndConnect(server);
    const res = await server.inject({
      url: "/wallet/sessions?contractId=CCONTRACT&network=testnet",
      headers: bearer("not-a-real-session"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /wallet/session returns the caller's OWN session from the bearer (no id in the URL)", async () => {
    const server = build(workingSubmitter());
    const { createSessionId } = await createAndConnect(server);
    const res = await server.inject({ url: "/wallet/session", headers: bearer(createSessionId) });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(createSessionId);
    expect(res.json().contractId).toBe("CCONTRACT");
    // No bearer -> 401.
    expect((await server.inject({ url: "/wallet/session" })).statusCode).toBe(401);
  });

  it("revokes another session on the SAME account via POST body (id never in the URL) + audits a HASHED ref", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId, connectSessionId } = await createAndConnect(server);

    // Revoke the connect session using the create session as the capability.
    const revoke = await server.inject({
      method: "POST",
      url: "/wallet/sessions/revoke",
      headers: bearer(createSessionId),
      payload: { targetSessionId: connectSessionId },
    });
    expect(revoke.statusCode).toBe(204);

    // The revoked session is now gone (absent).
    const gone = await server.inject({ url: "/wallet/session", headers: bearer(connectSessionId) });
    expect(gone.statusCode).toBe(401);

    // Audit records the event but NOT the raw session id — only a hashed ref.
    const events = await audit.list();
    const revoked = events.find((e) => e.type === "session.revoked");
    expect(revoked).toBeTruthy();
    const serialized = JSON.stringify(revoked);
    expect(serialized).not.toContain(connectSessionId);
    expect(serialized).not.toContain(createSessionId);
    expect(revoked?.data.sessionRef).toMatch(/^[0-9a-f]{12}$/); // truncated sha256
  });

  it("cannot revoke a session on a DIFFERENT account (cross-account revoke blocked)", async () => {
    const server = build(workingSubmitter());
    const { createSessionId } = await createAndConnect(server);
    // A second account.
    const other = await server.inject({
      method: "POST",
      url: "/wallet/create",
      payload: { ...createBody, keyId: "key-other", contractId: "COTHER2" },
    });
    const otherSessionId = other.json().sessionId as string;

    // Try to revoke the other account's session using OUR capability.
    const res = await server.inject({
      method: "POST",
      url: "/wallet/sessions/revoke",
      headers: bearer(createSessionId),
      payload: { targetSessionId: otherSessionId },
    });
    expect(res.statusCode).toBe(404); // the target isn't on our account → not found for us
    // The other session is still alive.
    expect(
      (await server.inject({ url: "/wallet/session", headers: bearer(otherSessionId) })).statusCode,
    ).toBe(200);
  });

  it("revoke without a bearer is refused (401), not performed", async () => {
    const server = build(workingSubmitter());
    const { connectSessionId } = await createAndConnect(server);
    const res = await server.inject({
      method: "POST",
      url: "/wallet/sessions/revoke",
      payload: { targetSessionId: connectSessionId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("an EXPIRED session bearer is treated as ABSENT (401, indistinguishable from never-existed)", async () => {
    // Drive time forward past the 7-day TTL via injected clock.
    let clock = new Date("2026-08-09T00:00:00.000Z");
    app = buildServer({ submitter: workingSubmitter(), now: () => clock });
    const create = await app.inject({ method: "POST", url: "/wallet/create", payload: createBody });
    const sid = create.json().sessionId as string;
    // Within TTL: works.
    expect((await app.inject({ url: "/wallet/session", headers: bearer(sid) })).statusCode).toBe(
      200,
    );
    // 8 days later: expired → 401, same as a bogus id.
    clock = new Date("2026-08-17T00:00:01.000Z");
    const expired = await app.inject({ url: "/wallet/session", headers: bearer(sid) });
    const bogus = await app.inject({ url: "/wallet/session", headers: bearer("nope") });
    expect(expired.statusCode).toBe(401);
    expect(bogus.statusCode).toBe(401);
    expect(expired.json()).toEqual(bogus.json());
  });

  it("rejects a bad list query (400) before touching auth", async () => {
    const server = build(workingSubmitter());
    const bad = await server.inject({ url: "/wallet/sessions?network=devnet" });
    expect(bad.statusCode).toBe(400);
  });
});

describe("session capability does NOT drift into general auth (RA-3 scope)", () => {
  const bearer = (id: string) => ({ authorization: `Bearer ${id}` });

  it("a valid session id on Authorization does NOT authorize /wallet/submit, /wallet/create, or bypass their own guards", async () => {
    const server = build(workingSubmitter());
    const create = await server.inject({
      method: "POST",
      url: "/wallet/create",
      payload: createBody,
    });
    const sid = create.json().sessionId as string;

    // /wallet/create still validates its body regardless of the bearer.
    const badCreate = await server.inject({
      method: "POST",
      url: "/wallet/create",
      headers: bearer(sid),
      payload: {},
    });
    expect(badCreate.statusCode).toBe(400);

    // /wallet/submit still validates its body regardless of the bearer — the
    // session capability grants nothing here.
    const badSubmit = await server.inject({
      method: "POST",
      url: "/wallet/submit",
      headers: bearer(sid),
      payload: {},
    });
    expect(badSubmit.statusCode).toBe(400);
  });
});

describe("sensitive wallet action audit logging (#313)", () => {
  const bearer = (id: string) => ({ authorization: `Bearer ${id}` });

  it("records audit log entries with actor, action, and timestamp for all sensitive wallet actions", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    // 1. policy.updated
    const policyRes = await server.inject({
      method: "POST",
      url: "/wallet/policy/update",
      headers: bearer(createSessionId),
      payload: { policyId: "pol-123", rules: { maxSpend: "100" } },
    });
    expect(policyRes.statusCode).toBe(200);

    // 2. account.merged
    const mergeRes = await server.inject({
      method: "POST",
      url: "/wallet/account/merge",
      headers: bearer(createSessionId),
      payload: { destinationContractId: "CDESTINATION" },
    });
    expect(mergeRes.statusCode).toBe(200);

    // 3. key.rotated
    const rotateRes = await server.inject({
      method: "POST",
      url: "/wallet/key/rotate",
      headers: bearer(createSessionId),
      payload: { oldKeyId: "key-old", newKeyId: "key-new" },
    });
    expect(rotateRes.statusCode).toBe(200);

    // 4. signer.added & signer.removed
    const addSignerRes = await server.inject({
      method: "POST",
      url: "/wallet/signer/manage",
      headers: bearer(createSessionId),
      payload: { action: "add", signerKey: "GNEWKEY", weight: 1 },
    });
    expect(addSignerRes.statusCode).toBe(200);

    // 5. threshold.updated (now 2 signers on the account, so threshold 2 is valid)
    const thresholdRes = await server.inject({
      method: "POST",
      url: "/wallet/threshold/update",
      headers: bearer(createSessionId),
      payload: { threshold: 2 },
    });
    expect(thresholdRes.statusCode).toBe(200);

    const removeSignerRes = await server.inject({
      method: "POST",
      url: "/wallet/signer/manage",
      headers: bearer(createSessionId),
      payload: { action: "remove", signerKey: "GNEWKEY" },
    });
    expect(removeSignerRes.statusCode).toBe(200);

    // Verify audit logs
    const auditLogsRes = await server.inject({
      url: "/wallet/audit-logs",
      headers: bearer(createSessionId),
    });
    expect(auditLogsRes.statusCode).toBe(200);
    const logs = auditLogsRes.json().auditLogs;

    const eventTypes = logs.map((l: { type: string }) => l.type);
    expect(eventTypes).toContain("policy.updated");
    expect(eventTypes).toContain("account.merged");
    expect(eventTypes).toContain("key.rotated");
    expect(eventTypes).toContain("threshold.updated");
    expect(eventTypes).toContain("signer.added");
    expect(eventTypes).toContain("signer.removed");

    for (const log of logs) {
      expect(log.actor).toBe("CCONTRACT");
      expect(log.at).toBeDefined();
    }
  });
});

describe("POST /wallet/policy/update - verification pipeline gate (issue #513)", () => {
  const bearer = (id: string) => ({ authorization: `Bearer ${id}` });

  it("accepts policy update when referenced contract is verified", async () => {
    const verificationClient = {
      getStatus: vi.fn().mockResolvedValue({ status: "verified" }),
    };
    const app = buildServer({
      submitter: workingSubmitter(),
      verificationClient,
    });
    const { createSessionId } = await createAndConnect(app);

    const res = await app.inject({
      method: "POST",
      url: "/wallet/policy/update",
      headers: bearer(createSessionId),
      payload: {
        policyId: "pol-verified",
        contractId: "CVERIFIEDCONTRACTID1234567890",
        rules: { maxSpend: "500" },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "updated", policyId: "pol-verified" });
    expect(verificationClient.getStatus).toHaveBeenCalledWith("CVERIFIEDCONTRACTID1234567890");
    await app.close();
  });

  it("rejects policy update when referenced contract is unverified or has no record", async () => {
    const verificationClient = {
      getStatus: vi.fn().mockResolvedValue({ status: "unverified" }),
    };
    const app = buildServer({
      submitter: workingSubmitter(),
      verificationClient,
    });
    const { createSessionId } = await createAndConnect(app);

    const res = await app.inject({
      method: "POST",
      url: "/wallet/policy/update",
      headers: bearer(createSessionId),
      payload: {
        policyId: "pol-unverified",
        contractId: "CUNVERIFIEDCONTRACTID12345678",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("unverified_contract");
    expect(body.message).toContain("CUNVERIFIEDCONTRACTID12345678");
    expect(body.contractId).toBe("CUNVERIFIEDCONTRACTID12345678");
    await app.close();
  });

  it("rejects with 503 when verification-service is unreachable", async () => {
    const verificationClient = {
      getStatus: vi.fn().mockRejectedValue(new Error("Connection refused")),
    };
    const app = buildServer({
      submitter: workingSubmitter(),
      verificationClient,
    });
    const { createSessionId } = await createAndConnect(app);

    const res = await app.inject({
      method: "POST",
      url: "/wallet/policy/update",
      headers: bearer(createSessionId),
      payload: {
        policyId: "pol-failure",
        rules: { contractId: "CUNREACHABLECONTRACT" },
      },
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe("verification_service_unavailable");
    expect(body.message).toContain("unreachable");
    await app.close();
  });
});

describe("POST /wallet/signer/manage - optimistic concurrency guard (issue #509)", () => {
  const bearer = (id: string) => ({ authorization: `Bearer ${id}` });

  it("allows sequential updates with matching expectedVersion", async () => {
    const app = buildServer({ submitter: workingSubmitter() });
    const { createSessionId } = await createAndConnect(app);

    // Initial signer set version is 0. Update with expectedVersion 0:
    const res1 = await app.inject({
      method: "POST",
      url: "/wallet/signer/manage",
      headers: bearer(createSessionId),
      payload: { action: "add", signerKey: "GSIGNER1", version: 0 },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json()).toEqual({ status: "signer_updated", action: "add", version: 1 });

    // Next mutation with expectedVersion 1 succeeds:
    const res2 = await app.inject({
      method: "POST",
      url: "/wallet/signer/manage",
      headers: bearer(createSessionId),
      payload: { action: "remove", signerKey: "GSIGNER1", version: 1 },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ status: "signer_updated", action: "remove", version: 2 });
    await app.close();
  });

  it("rejects conflicting concurrent mutation with 409 and indicates updated version for retry", async () => {
    const app = buildServer({ submitter: workingSubmitter() });
    const { createSessionId } = await createAndConnect(app);

    // Request 1 and Request 2 both read version 0.
    // Request 1 executes:
    const res1 = await app.inject({
      method: "POST",
      url: "/wallet/signer/manage",
      headers: bearer(createSessionId),
      payload: { action: "add", signerKey: "GSIGNER1", expectedVersion: 0 },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().version).toBe(1);

    // Request 2 (stale, still expects version 0) is rejected:
    const res2 = await app.inject({
      method: "POST",
      url: "/wallet/signer/manage",
      headers: bearer(createSessionId),
      payload: { action: "add", signerKey: "GSIGNER2", expectedVersion: 0 },
    });
    expect(res2.statusCode).toBe(409);
    const conflict = res2.json();
    expect(conflict.error).toBe("conflict");
    expect(conflict.code).toBe("signer_version_conflict");
    expect(conflict.currentVersion).toBe(1);

    // Client retries with refreshed currentVersion (1):
    const resRetry = await app.inject({
      method: "POST",
      url: "/wallet/signer/manage",
      headers: bearer(createSessionId),
      payload: { action: "add", signerKey: "GSIGNER2", expectedVersion: 1 },
    });
    expect(resRetry.statusCode).toBe(200);
    expect(resRetry.json().version).toBe(2);
    await app.close();
  });
});

describe("GET /wallet/audit-logs - actor-based filtering (issue #512)", () => {
  const bearer = (id: string) => ({ authorization: `Bearer ${id}` });

  it("filters audit logs by passkey, device, and policy actors", async () => {
    const audit = createMemoryAuditLog();
    const app = buildServer({ submitter: workingSubmitter(), audit });
    const { createSessionId } = await createAndConnect(app);

    // Perform operations representing policy, device, and passkey:
    await app.inject({
      method: "POST",
      url: "/wallet/policy/update",
      headers: bearer(createSessionId),
      payload: { policyId: "pol-test" },
    });

    await app.inject({
      method: "POST",
      url: "/wallet/signer/manage",
      headers: bearer(createSessionId),
      payload: { action: "add", signerKey: "GDEV1", actor: "device" },
    });

    await app.inject({
      method: "POST",
      url: "/wallet/key/rotate",
      headers: bearer(createSessionId),
      payload: { oldKeyId: "k-old", newKeyId: "k-new" },
    });

    // 1. Filter by policy:
    const policyLogsRes = await app.inject({
      url: "/wallet/audit-logs?actor=policy",
      headers: bearer(createSessionId),
    });
    expect(policyLogsRes.statusCode).toBe(200);
    const policyLogs = policyLogsRes.json().auditLogs;
    expect(policyLogs.length).toBeGreaterThanOrEqual(1);
    expect(policyLogs.every((l: { type: string }) => l.type.startsWith("policy."))).toBe(true);

    // 2. Filter by device:
    const deviceLogsRes = await app.inject({
      url: "/wallet/audit-logs?actor=device",
      headers: bearer(createSessionId),
    });
    expect(deviceLogsRes.statusCode).toBe(200);
    const deviceLogs = deviceLogsRes.json().auditLogs;
    expect(deviceLogs.length).toBeGreaterThanOrEqual(1);
    expect(
      deviceLogs.every(
        (l: { type: string }) => l.type.startsWith("signer.") || l.type.startsWith("session."),
      ),
    ).toBe(true);

    // 3. Filter by passkey:
    const passkeyLogsRes = await app.inject({
      url: "/wallet/audit-logs?actor=passkey",
      headers: bearer(createSessionId),
    });
    expect(passkeyLogsRes.statusCode).toBe(200);
    const passkeyLogs = passkeyLogsRes.json().auditLogs;
    expect(passkeyLogs.length).toBeGreaterThanOrEqual(1);
    expect(
      passkeyLogs.every(
        (l: { type: string }) => l.type.startsWith("key.") || l.type.startsWith("wallet."),
      ),
    ).toBe(true);

    // 4. Parameter omitted returns all entries:
    const allLogsRes = await app.inject({
      url: "/wallet/audit-logs",
      headers: bearer(createSessionId),
    });
    expect(allLogsRes.statusCode).toBe(200);
    expect(allLogsRes.json().auditLogs.length).toBeGreaterThanOrEqual(3);

    await app.close();
  });

  it("returns 400 when an invalid actor value is provided", async () => {
    const app = buildServer({ submitter: workingSubmitter() });
    const { createSessionId } = await createAndConnect(app);

    const res = await app.inject({
      url: "/wallet/audit-logs?actor=invalid_signer",
      headers: bearer(createSessionId),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_actor");
    await app.close();
  });
});

describe("POST /wallet/threshold/update (issue #508)", () => {
  const bearer = (id: string) => ({ authorization: `Bearer ${id}` });

  it("accepts threshold equal to signer count (boundary condition)", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    // Initial signer count is 1. Threshold = 1 is valid (1 == 1).
    const res = await server.inject({
      method: "POST",
      url: "/wallet/threshold/update",
      headers: bearer(createSessionId),
      payload: { threshold: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "threshold_updated", threshold: 1 });
  });

  it("accepts threshold less than signer count", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    // Add 2 signers (total 3: 1 initial + 2 added)
    await server.inject({
      method: "POST",
      url: "/wallet/signer/manage",
      headers: bearer(createSessionId),
      payload: { action: "add", signerKey: "GSIGNER1" },
    });
    await server.inject({
      method: "POST",
      url: "/wallet/signer/manage",
      headers: bearer(createSessionId),
      payload: { action: "add", signerKey: "GSIGNER2" },
    });

    const res = await server.inject({
      method: "POST",
      url: "/wallet/threshold/update",
      headers: bearer(createSessionId),
      payload: { threshold: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "threshold_updated", threshold: 2 });
  });

  it("accepts explicit signerCount and threshold <= signerCount", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    const res = await server.inject({
      method: "POST",
      url: "/wallet/threshold/update",
      headers: bearer(createSessionId),
      payload: { threshold: 3, signerCount: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "threshold_updated", threshold: 3 });
  });

  it("rejects threshold exceeding signer count with clear 400 error", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    // Default account has 1 signer, requested threshold is 2
    const res = await server.inject({
      method: "POST",
      url: "/wallet/threshold/update",
      headers: bearer(createSessionId),
      payload: { threshold: 2 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "threshold_exceeds_signers",
      message: "Threshold 2 exceeds signer count 1",
      threshold: 2,
      signerCount: 1,
    });
  });

  it("rejects threshold exceeding explicit signerCount", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    const res = await server.inject({
      method: "POST",
      url: "/wallet/threshold/update",
      headers: bearer(createSessionId),
      payload: { threshold: 5, signerCount: 3 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "threshold_exceeds_signers",
      message: "Threshold 5 exceeds signer count 3",
      threshold: 5,
      signerCount: 3,
    });
  });

  it("rejects threshold of zero with invalid_threshold error", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    const res = await server.inject({
      method: "POST",
      url: "/wallet/threshold/update",
      headers: bearer(createSessionId),
      payload: { threshold: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_threshold",
      message: "Threshold must be greater than zero",
      threshold: 0,
    });
  });

  it("rejects negative threshold with invalid_threshold error", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    const res = await server.inject({
      method: "POST",
      url: "/wallet/threshold/update",
      headers: bearer(createSessionId),
      payload: { threshold: -1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_threshold",
      message: "Threshold must be greater than zero",
      threshold: -1,
    });
  });

  it("rejects missing bearer with 401", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({
      method: "POST",
      url: "/wallet/threshold/update",
      payload: { threshold: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /wallet/transactions (issue #256)", () => {
  const bearer = (id: string) => ({ authorization: `Bearer ${id}` });
  const PASSPHRASE = "Test SDF Network ; September 2015";
  const KEY_ID = "AAECAwQFBgcICQoLDA0ODw";
  const CONTRACT_ID = deriveWalletContractId(KEY_ID, { networkPassphrase: PASSPHRASE });

  // A derivation-gated server (networkPassphrase set) rejects a create whose
  // contractId isn't derive(keyId) (V1), so the end-to-end tests below (which
  // build a server WITH networkPassphrase, to exercise the real submit-time
  // scoping check) must use the real derived value, not the plain "CCONTRACT"
  // placeholder createAndConnect/createBody use above.
  async function createAndConnectDerived(server: FastifyInstance) {
    const create = await server.inject({
      method: "POST",
      url: "/wallet/create",
      payload: { keyId: KEY_ID, contractId: CONTRACT_ID, network: "testnet", signedTx: "xdr" },
    });
    const connect = await server.inject({
      method: "POST",
      url: "/wallet/connect",
      payload: { keyId: KEY_ID, network: "testnet" },
    });
    return {
      createSessionId: create.json().sessionId as string,
      connectSessionId: connect.json().sessionId as string,
    };
  }

  function buildInvokeTx(subject: string): string {
    const source = Keypair.random();
    const account = new Account(source.publicKey(), "0");
    const addr = Address.fromString(subject);
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: addr.toScAddress(),
          nonce: xdr.Int64.fromString("0"),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: addr.toScAddress(),
            functionName: "transfer",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });
    const op = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: addr.toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      auth: [authEntry],
    });
    return new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
      .addOperation(op)
      .setTimeout(30)
      .build()
      .toXDR();
  }

  function buildScopedServer(submitter: TransactionSubmitter, audit?: AuditLog) {
    const wallets = createMemoryWalletRepository();
    app = buildServer({ submitter, wallets, audit, networkPassphrase: PASSPHRASE });
    return { server: app, wallets };
  }

  it("shows a real /wallet/submit transaction in the submitting wallet's history (end-to-end)", async () => {
    const submitter = workingSubmitter();
    const audit = createMemoryAuditLog();
    const { server } = buildScopedServer(submitter, audit);
    // /wallet/create itself inserts the wallet mapping; pre-inserting it
    // separately here would make /wallet/create 409 (DuplicateWalletError)
    // and leave createSessionId undefined.
    const { createSessionId } = await createAndConnectDerived(server);

    const submitRes = await server.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: { signedXdr: buildInvokeTx(CONTRACT_ID), network: "testnet" },
    });
    expect(submitRes.statusCode).toBe(200);
    const { hash } = submitRes.json();

    const res = await server.inject({
      url: `/wallet/transactions?contractId=${CONTRACT_ID}&network=testnet`,
      headers: bearer(createSessionId),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].txHash).toBe(hash);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("does not show another wallet's transaction (no cross-account leak)", async () => {
    const submitter = workingSubmitter();
    const audit = createMemoryAuditLog();
    const { server, wallets } = buildScopedServer(submitter, audit);
    // /wallet/create itself inserts CONTRACT_ID's mapping; only OTHER (a
    // different wallet, not going through /wallet/create in this test) is
    // inserted directly.
    const OTHER = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
    await wallets.insert({
      keyId: "k2",
      contractId: OTHER,
      network: "testnet",
      createdAt: new Date().toISOString(),
    });
    const { createSessionId } = await createAndConnectDerived(server);

    // A transaction for the OTHER wallet, recorded directly (no session for
    // OTHER exists to submit through the real route, and none should be
    // needed to prove the point: CONTRACT_ID's history must never include it).
    await audit.record("tx.submitted", { network: "testnet", txHash: "other-hash" }, OTHER);

    const res = await server.inject({
      url: `/wallet/transactions?contractId=${CONTRACT_ID}&network=testnet`,
      headers: bearer(createSessionId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactions).toHaveLength(0);
  });

  it("rejects a bearer for a DIFFERENT contract than the one queried (no cross-account read)", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);
    const res = await server.inject({
      url: "/wallet/transactions?contractId=COTHER&network=testnet",
      headers: bearer(createSessionId),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing bearer with 401", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({
      url: "/wallet/transactions?contractId=CCONTRACT&network=testnet",
    });
    expect(res.statusCode).toBe(401);
  });

  it("paginates: first page, middle page, and the terminal empty-cursor page, with no row skipped or duplicated", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    // 5 events, oldest first; listPage returns newest first.
    for (let i = 0; i < 5; i++) {
      await audit.record("tx.submitted", { network: "testnet", txHash: `hash-${i}` }, "CCONTRACT");
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/wallet/transactions?contractId=CCONTRACT&network=testnet&limit=2&after=${encodeURIComponent(cursor)}`
        : `/wallet/transactions?contractId=CCONTRACT&network=testnet&limit=2`;
      const res = await server.inject({ url, headers: bearer(createSessionId) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.transactions.length).toBeLessThanOrEqual(2);
      for (const tx of body.transactions) seen.push(tx.txHash);
      if (!body.hasMore) {
        expect(body.nextCursor).toBeNull();
        break;
      }
      expect(body.nextCursor).toBeTruthy();
      cursor = body.nextCursor;
    }

    expect(seen).toEqual(["hash-4", "hash-3", "hash-2", "hash-1", "hash-0"]);
  });

  it("returns an empty page (not an error) for a wallet with no transactions", async () => {
    const server = build(workingSubmitter());
    const { createSessionId } = await createAndConnect(server);
    const res = await server.inject({
      url: "/wallet/transactions?contractId=CCONTRACT&network=testnet",
      headers: bearer(createSessionId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transactions: [], hasMore: false, nextCursor: null });
  });

  it("caps limit at MAX_TX_HISTORY_LIMIT rather than trusting an oversized caller value", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);
    for (let i = 0; i < 5; i++) {
      await audit.record("tx.submitted", { network: "testnet", txHash: `hash-${i}` }, "CCONTRACT");
    }
    const res = await server.inject({
      url: "/wallet/transactions?contractId=CCONTRACT&network=testnet&limit=999999",
      headers: bearer(createSessionId),
    });
    expect(res.statusCode).toBe(200);
    // Only 5 events exist, so this doesn't prove the cap alone, but does
    // prove an oversized limit is accepted (not a 400) and doesn't error.
    expect(res.json().transactions).toHaveLength(5);
  });

  it("rejects a malformed cursor with 400, not 500", async () => {
    const server = build(workingSubmitter());
    const { createSessionId } = await createAndConnect(server);
    const res = await server.inject({
      url: "/wallet/transactions?contractId=CCONTRACT&network=testnet&after=not-a-real-cursor",
      headers: bearer(createSessionId),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_cursor");
  });

  it("filters transactions by status (submitted, failed, policy-rejected) and returns mixed page without filter", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    await audit.record("tx.submitted", { network: "testnet", txHash: "sub-1" }, "CCONTRACT");
    await audit.record(
      "tx.failed",
      { network: "testnet", error: "tx_insufficient_balance" },
      "CCONTRACT",
    );
    await audit.record(
      "tx.policy_rejected",
      { network: "testnet", reason: "disallowed contract" },
      "CCONTRACT",
    );

    // All 3 in one page when no status filter is provided
    const allRes = await server.inject({
      url: "/wallet/transactions?contractId=CCONTRACT&network=testnet",
      headers: bearer(createSessionId),
    });
    expect(allRes.statusCode).toBe(200);
    const allTxs = allRes.json().transactions;
    expect(allTxs).toHaveLength(3);
    expect(allTxs.map((t: { status: string }) => t.status)).toEqual([
      "policy-rejected",
      "failed",
      "submitted",
    ]);

    // Filter status=policy-rejected
    const policyRes = await server.inject({
      url: "/wallet/transactions?contractId=CCONTRACT&network=testnet&status=policy-rejected",
      headers: bearer(createSessionId),
    });
    expect(policyRes.statusCode).toBe(200);
    expect(policyRes.json().transactions).toHaveLength(1);
    expect(policyRes.json().transactions[0].status).toBe("policy-rejected");
    expect(policyRes.json().transactions[0].reason).toBe("disallowed contract");

    // Filter status=failed
    const failedRes = await server.inject({
      url: "/wallet/transactions?contractId=CCONTRACT&network=testnet&status=failed",
      headers: bearer(createSessionId),
    });
    expect(failedRes.statusCode).toBe(200);
    expect(failedRes.json().transactions).toHaveLength(1);
    expect(failedRes.json().transactions[0].status).toBe("failed");
    expect(failedRes.json().transactions[0].error).toBe("tx_insufficient_balance");

    // Filter status=submitted
    const submittedRes = await server.inject({
      url: "/wallet/transactions?contractId=CCONTRACT&network=testnet&status=submitted",
      headers: bearer(createSessionId),
    });
    expect(submittedRes.statusCode).toBe(200);
    expect(submittedRes.json().transactions).toHaveLength(1);
    expect(submittedRes.json().transactions[0].status).toBe("submitted");
    expect(submittedRes.json().transactions[0].txHash).toBe("sub-1");

    // Invalid status returns 400
    const invalidRes = await server.inject({
      url: "/wallet/transactions?contractId=CCONTRACT&network=testnet&status=unknown-status",
      headers: bearer(createSessionId),
    });
    expect(invalidRes.statusCode).toBe(400);
  });
});

describe("POST /wallet/account/merge (issue #511)", () => {
  const bearer = (id: string) => ({ authorization: `Bearer ${id}` });

  it("returns preview merge plan with dryRun: true without auditing account.merged", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    const res = await server.inject({
      method: "POST",
      url: "/wallet/account/merge",
      headers: bearer(createSessionId),
      payload: {
        destinationContractId: "CDESTINATION456",
        dryRun: true,
        balances: [
          { asset: "native", amount: "50", isNative: true },
          { asset: "USDC:GXXX", amount: "0", hasTrustline: true },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("preview");
    expect(body.dryRun).toBe(true);
    expect(body.plan.source).toBe("CCONTRACT");
    expect(body.plan.destination).toBe("CDESTINATION456");
    expect(body.plan.canMerge).toBe(true);
    expect(body.plan.assetsMoved).toEqual([{ asset: "native", amount: "50", isNative: true }]);
    expect(body.plan.trustlinesAffected).toEqual([{ asset: "USDC:GXXX", status: "closed" }]);

    // Confirm nothing was written to audit log
    const events = await audit.list();
    expect(events.filter((e) => e.type === "account.merged")).toHaveLength(0);
  });

  it("blocks merge when account has non-zero non-native balances / open trustlines", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    const res = await server.inject({
      method: "POST",
      url: "/wallet/account/merge",
      headers: bearer(createSessionId),
      payload: {
        destinationContractId: "CDESTINATION456",
        dryRun: false,
        balances: [
          { asset: "native", amount: "100", isNative: true },
          { asset: "USDC:GXXX", amount: "15.5", hasTrustline: true },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("cannot_merge_with_open_trustlines");
    expect(body.blockers).toContain(
      "Non-zero balance (15.5) on trustline USDC:GXXX must be zeroed before merge",
    );
    expect(body.plan.canMerge).toBe(false);

    // Confirm nothing was written to audit log
    const events = await audit.list();
    expect(events.filter((e) => e.type === "account.merged")).toHaveLength(0);
  });

  it("executes merge cleanly when no blockers exist and dryRun is false", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { createSessionId } = await createAndConnect(server);

    const res = await server.inject({
      method: "POST",
      url: "/wallet/account/merge?dryRun=false",
      headers: bearer(createSessionId),
      payload: {
        destinationContractId: "CDESTINATION456",
        balances: [
          { asset: "native", amount: "100", isNative: true },
          { asset: "USDC:GXXX", amount: "0", hasTrustline: true },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("merged");
    expect(body.destination).toBe("CDESTINATION456");
    expect(body.plan.canMerge).toBe(true);

    const events = await audit.list();
    expect(events.filter((e) => e.type === "account.merged")).toHaveLength(1);
  });
});

describe("POST /wallet/key/rotate (issue #510)", () => {
  const bearer = (id: string) => ({ authorization: `Bearer ${id}` });

  it("rejects rotation with 409 in_flight_submission_conflict when a submission is in flight", async () => {
    const inFlightTracker = createMemoryInFlightTracker();
    const server = buildServer({ submitter: workingSubmitter(), inFlightTracker });
    const { createSessionId } = await createAndConnect(server);

    // Simulate in-flight submission started for CCONTRACT
    const release = inFlightTracker.start("CCONTRACT");

    const res = await server.inject({
      method: "POST",
      url: "/wallet/key/rotate",
      headers: bearer(createSessionId),
      payload: { oldKeyId: "key-abc", newKeyId: "key-def" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "in_flight_submission_conflict",
      message: "Cannot rotate key while a transaction submission is in flight for this wallet.",
    });

    // Complete the in-flight submission
    release();

    // Now rotation succeeds cleanly
    const retryRes = await server.inject({
      method: "POST",
      url: "/wallet/key/rotate",
      headers: bearer(createSessionId),
      payload: { oldKeyId: "key-abc", newKeyId: "key-def" },
    });

    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json()).toEqual({ status: "rotated", newKeyId: "key-def" });
  });
});

describe("POST /wallet/submit idempotency via signed XDR hash (#515)", () => {
  it("returns the original submission result for identical signed envelope without resubmitting", async () => {
    const submitter = { submit: vi.fn().mockResolvedValue({ hash: "txhash-dedup-1" }) };
    const server = buildServer({ submitter });

    const payload = { signedXdr: "envelope-xdr-identical-123", network: "testnet" };

    const first = await server.inject({ method: "POST", url: "/wallet/submit", payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ hash: "txhash-dedup-1" });
    expect(submitter.submit).toHaveBeenCalledTimes(1);

    // Resubmit identical signed XDR envelope
    const second = await server.inject({ method: "POST", url: "/wallet/submit", payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ hash: "txhash-dedup-1" });
    expect(submitter.submit).toHaveBeenCalledTimes(1); // not called again!
  });

  it("does not deduplicate two different signed envelopes for the same logical payment", async () => {
    const submitter = {
      submit: vi
        .fn()
        .mockResolvedValueOnce({ hash: "txhash-envelope-1" })
        .mockResolvedValueOnce({ hash: "txhash-envelope-2" }),
    };
    const server = buildServer({ submitter });

    const payload1 = { signedXdr: "envelope-xdr-version-1", network: "testnet" };
    const payload2 = { signedXdr: "envelope-xdr-version-2", network: "testnet" };

    const first = await server.inject({ method: "POST", url: "/wallet/submit", payload: payload1 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ hash: "txhash-envelope-1" });

    const second = await server.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: payload2,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ hash: "txhash-envelope-2" });
    expect(submitter.submit).toHaveBeenCalledTimes(2);
  });

  it("invalidates balance cache for affected wallets on successful submit (#520)", async () => {
    const cache = {
      get: vi.fn().mockResolvedValue({ hit: false }),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      invalidateBalance: vi.fn().mockResolvedValue(undefined),
    };
    const submitter = { submit: vi.fn().mockResolvedValue({ hash: "txhash-cache-inval" }) };
    const server = buildServer({ submitter, cache });

    const res = await server.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: { signedXdr: "test-signed-xdr-balance-inval", network: "testnet" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /wallet/jobs and job status lookup (#516)", () => {
  it("enqueues a job with queued status and exposes it via GET /wallet/jobs/:recordId", async () => {
    const server = build(workingSubmitter());

    const res = await server.inject({
      method: "POST",
      url: "/wallet/jobs",
      payload: {
        recordId: "job-rec-1",
        contractId: "CCONTRACT",
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().enqueued).toBe(true);
    expect(res.json().status).toBe("queued");
    expect(res.json().recordId).toBe("job-rec-1");

    // Lookup job
    const lookup = await server.inject({
      url: "/wallet/jobs/job-rec-1",
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({
      recordId: "job-rec-1",
      contractId: "CCONTRACT",
      status: "queued",
    });
  });

  it("exposes building status and transitions to stuck purely due to elapsed time", async () => {
    let clock = new Date("2026-08-01T12:00:00.000Z");
    const server = buildServer({
      submitter: workingSubmitter(),
      now: () => clock,
      jobStuckThresholdMs: 300_000, // 5 minutes
    });

    await server.inject({
      method: "POST",
      url: "/wallet/jobs",
      payload: { recordId: "job-rec-building", contractId: "CCONTRACT" },
    });

    // Flip to building at 12:01
    clock = new Date("2026-08-01T12:01:00.000Z");
    const patch = await server.inject({
      method: "PATCH",
      url: "/wallet/jobs/job-rec-building",
      payload: { status: "building" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().status).toBe("building");

    // 2 minutes later: still building
    clock = new Date("2026-08-01T12:03:00.000Z");
    const lookupBuilding = await server.inject({ url: "/wallet/jobs/job-rec-building" });
    expect(lookupBuilding.statusCode).toBe(200);
    expect(lookupBuilding.json().status).toBe("building");

    // 6 minutes after transition: exceeded 5 min threshold without any event -> status is stuck!
    clock = new Date("2026-08-01T12:07:01.000Z");
    const lookupStuck = await server.inject({ url: "/wallet/jobs/job-rec-building" });
    expect(lookupStuck.statusCode).toBe(200);
    expect(lookupStuck.json().status).toBe("stuck");
  });

  it("returns 404 for unknown job recordId", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({ url: "/wallet/jobs/unknown-job-id" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("job_not_found");
  });
});

describe("GET /wallet/session response shape for contract id (#517)", () => {
  it("asserts exact 401 response shape when no session exists", async () => {
    const server = build(workingSubmitter());

    // Without bearer header
    const noHeader = await server.inject({ url: "/wallet/session" });
    expect(noHeader.statusCode).toBe(401);
    expect(noHeader.json()).toEqual({ error: "unauthorized" });

    // With unknown bearer
    const unknownBearer = await server.inject({
      url: "/wallet/session",
      headers: { authorization: "Bearer bogus-token-12345" },
    });
    expect(unknownBearer.statusCode).toBe(401);
    expect(unknownBearer.json()).toEqual({ error: "unauthorized" });
  });

  it("asserts exact 401 response shape when session exists for a different contractId", async () => {
    const server = build(workingSubmitter());
    const { createSessionId } = await createAndConnect(server);

    // Query for a contractId that differs from the session's contractId
    const mismatch = await server.inject({
      url: "/wallet/session?contractId=CDIFFERENT_CONTRACT",
      headers: { authorization: `Bearer ${createSessionId}` },
    });
    expect(mismatch.statusCode).toBe(401);
    expect(mismatch.json()).toEqual({ error: "unauthorized" });

    // Matching contractId returns 200 with session record shape
    const match = await server.inject({
      url: "/wallet/session?contractId=CCONTRACT",
      headers: { authorization: `Bearer ${createSessionId}` },
    });
    expect(match.statusCode).toBe(200);
    expect(match.json()).toMatchObject({
      id: createSessionId,
      contractId: "CCONTRACT",
      network: "testnet",
    });
  });

  it("asserts exact 401 response shape when session has expired", async () => {
    let clock = new Date("2026-08-01T00:00:00.000Z");
    const server = buildServer({ submitter: workingSubmitter(), now: () => clock });

    const create = await server.inject({
      method: "POST",
      url: "/wallet/create",
      payload: createBody,
    });
    const sessionId = create.json().sessionId as string;

    // Advance clock past 7 days (SESSION_TTL_MS)
    clock = new Date("2026-08-10T00:00:01.000Z");
    const expiredRes = await server.inject({
      url: "/wallet/session?contractId=CCONTRACT",
      headers: { authorization: `Bearer ${sessionId}` },
    });
    expect(expiredRes.statusCode).toBe(401);
    expect(expiredRes.json()).toEqual({ error: "unauthorized" });
  });
});

describe("GET /health", () => {
  it("responds ok", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({ url: "/health" });
    expect(res.json()).toEqual({ status: "ok", service: "wallet-service" });
  });
});
