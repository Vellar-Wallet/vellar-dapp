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
import {
  createMemoryAuditLog,
  createMemorySessionRepository,
  createMemoryWalletRepository,
  type AuditLog,
  type SessionRepository,
} from "./repository";
import { createUnconfiguredSubmitter, SubmissionError, type TransactionSubmitter } from "./relayer";
import { buildServer } from "./server";
import { deriveWalletContractId } from "./derivation";
import { createMemoryReplayGuard } from "./replay";
import { buildInvokeTx, KNOWN_WALLET, OTHER_CONTRACT, PASSPHRASE } from "./test-fixtures";

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

  // RA-3 L-1: the list route must judge expiry with the SAME injected clock the
  // bearer check uses. It used to fall back to the store's wall clock, so under
  // an injected clock the two disagreed (and expiry on the list was untestable).
  it("lists sessions as of the injected clock, not the wall clock (L-1)", async () => {
    // 2026-08 is long past in real time: a wall-clock filter would call both
    // sessions expired and return [].
    const clock = new Date("2026-08-09T00:00:00.000Z");
    app = buildServer({ submitter: workingSubmitter(), now: () => clock });
    const create = await app.inject({ method: "POST", url: "/wallet/create", payload: createBody });
    const connect = await app.inject({
      method: "POST",
      url: "/wallet/connect",
      payload: { keyId: createBody.keyId, network: "testnet" },
    });
    const ids = [create.json().sessionId, connect.json().sessionId] as string[];

    const res = await app.inject({
      url: "/wallet/sessions?contractId=CCONTRACT&network=testnet",
      headers: bearer(ids[0]!),
    });

    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .sessions.map((s: { id: string }) => s.id)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it("omits a session that expired under the injected clock from the list (L-1)", async () => {
    let clock = new Date("2026-08-09T00:00:00.000Z");
    app = buildServer({ submitter: workingSubmitter(), now: () => clock });
    const old = await app.inject({ method: "POST", url: "/wallet/create", payload: createBody });
    const oldId = old.json().sessionId as string;
    // 3 days later a second device connects; the first is never used again.
    clock = new Date("2026-08-12T00:00:00.000Z");
    const fresh = await app.inject({
      method: "POST",
      url: "/wallet/connect",
      payload: { keyId: createBody.keyId, network: "testnet" },
    });
    const freshId = fresh.json().sessionId as string;
    // 8 days after the first session's last use: it has expired, the second is live.
    clock = new Date("2026-08-17T00:00:01.000Z");

    const res = await app.inject({
      url: "/wallet/sessions?contractId=CCONTRACT&network=testnet",
      headers: bearer(freshId),
    });

    expect(res.statusCode).toBe(200);
    const listed = res.json().sessions.map((s: { id: string }) => s.id);
    expect(listed).toEqual([freshId]);
    expect(listed).not.toContain(oldId);
  });

  // RA-3 L-5: GET /wallet/session returned the record as it was BEFORE the
  // authorised-use slide, so the caller saw a stale lastActiveAt / expiresAt
  // that disagreed with what the store (and the list route) held.
  it("GET /wallet/session shows the slid lastActiveAt and expiresAt, not the pre-slide values (L-5)", async () => {
    let clock = new Date("2026-08-09T00:00:00.000Z");
    app = buildServer({ submitter: workingSubmitter(), now: () => clock });
    const create = await app.inject({ method: "POST", url: "/wallet/create", payload: createBody });
    const sid = create.json().sessionId as string;

    clock = new Date("2026-08-11T12:00:00.000Z");
    const res = await app.inject({ url: "/wallet/session", headers: bearer(sid) });

    expect(res.statusCode).toBe(200);
    expect(res.json().createdAt).toBe("2026-08-09T00:00:00.000Z");
    expect(res.json().lastActiveAt).toBe("2026-08-11T12:00:00.000Z");
    expect(res.json().expiresAt).toBe("2026-08-18T12:00:00.000Z");

    // The list route reads the store; both views must now agree.
    const list = await app.inject({
      url: "/wallet/sessions?contractId=CCONTRACT&network=testnet",
      headers: bearer(sid),
    });
    expect(list.json().sessions[0]).toMatchObject({
      lastActiveAt: "2026-08-11T12:00:00.000Z",
      expiresAt: "2026-08-18T12:00:00.000Z",
    });
  });

  it("treats a session that vanishes between find and touch as absent (401), not as authorised (L-5)", async () => {
    const real = createMemorySessionRepository();
    const racing: SessionRepository = { ...real, touch: async () => false };
    app = buildServer({ submitter: workingSubmitter(), sessions: racing });
    const create = await app.inject({ method: "POST", url: "/wallet/create", payload: createBody });

    const res = await app.inject({
      url: "/wallet/session",
      headers: bearer(create.json().sessionId as string),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
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

describe("GET /health", () => {
  it("responds ok", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({ url: "/health" });
    expect(res.json()).toEqual({ status: "ok", service: "wallet-service" });
  });
});

describe("POST /wallet/submit replay protection (approved design 1A)", () => {
  const LATEST = 10_000;
  const SOON = LATEST + 6; // the kit default window
  const wallets = () => {
    const repo = createMemoryWalletRepository();
    return repo;
  };

  async function register(repo: ReturnType<typeof wallets>) {
    for (const network of ["testnet", "mainnet"] as const) {
      await repo.insert({
        keyId: `k-${network}`,
        contractId: KNOWN_WALLET,
        network,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async function replayServer(
    submitter: TransactionSubmitter,
    extra: Partial<Parameters<typeof buildServer>[0]> = {},
  ) {
    const repo = wallets();
    await register(repo);
    const audit = createMemoryAuditLog();
    app = buildServer({
      submitter,
      wallets: repo,
      audit,
      networkPassphrase: PASSPHRASE,
      budgetNetwork: "testnet",
      replayGuard: createMemoryReplayGuard(),
      getLatestLedger: async () => LATEST,
      ...extra,
    });
    return { server: app, audit };
  }

  const post = (server: FastifyInstance, signedXdr: string, network = "testnet") =>
    server.inject({ method: "POST", url: "/wallet/submit", payload: { signedXdr, network } });

  const tx = (nonce: string, expiration = SOON) =>
    buildInvokeTx([{ subject: KNOWN_WALLET, nonce, expiration }]);

  it("accepts a fresh submission and refuses the same signed tx the second time (409)", async () => {
    const submitter = workingSubmitter();
    const { server } = await replayServer(submitter);
    const signed = tx("1");

    const first = await post(server, signed);
    const second = await post(server, signed);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("replay_detected");
    expect(submitter.submit).toHaveBeenCalledTimes(1);
  });

  it("concurrent identical submissions: exactly one reaches the submitter, the rest get 409", async () => {
    // A slow submitter keeps the first request in flight while the copies arrive,
    // which is the window where each copy would otherwise pass simulation and
    // consume budget.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const submitter: TransactionSubmitter = {
      submit: vi.fn(async () => {
        await gate;
        return { hash: "h" };
      }),
    };
    const { server } = await replayServer(submitter);
    const signed = tx("77");

    const inFlight = Array.from({ length: 6 }, () => post(server, signed));
    await vi.waitFor(() => expect(submitter.submit).toHaveBeenCalledTimes(1));
    release();
    const results = await Promise.all(inFlight);

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(5);
    expect(submitter.submit).toHaveBeenCalledTimes(1);
  });

  it("a re-wrapped envelope (new source, sequence, fee) with the same auth is still a replay", async () => {
    const submitter = workingSubmitter();
    const { server } = await replayServer(submitter);
    const a = tx("500");
    const b = tx("500"); // different random source account => different tx hash

    expect(a).not.toBe(b);
    expect((await post(server, a)).statusCode).toBe(200);
    expect((await post(server, b)).statusCode).toBe(409);
    expect(submitter.submit).toHaveBeenCalledTimes(1);
  });

  it("distinct nonces are independent submissions", async () => {
    const submitter = workingSubmitter();
    const { server } = await replayServer(submitter);

    expect((await post(server, tx("1"))).statusCode).toBe(200);
    expect((await post(server, tx("2"))).statusCode).toBe(200);
    expect(submitter.submit).toHaveBeenCalledTimes(2);
  });

  it("flipping the body `network` label cannot evade the replay check (V5: config decides)", async () => {
    const submitter = workingSubmitter();
    const { server } = await replayServer(submitter);
    const signed = tx("31");

    expect((await post(server, signed, "testnet")).statusCode).toBe(200);
    expect((await post(server, signed, "mainnet")).statusCode).toBe(409);
    expect(submitter.submit).toHaveBeenCalledTimes(1);
  });

  describe("a tx with several auth entries is reserved all-or-nothing", () => {
    it("refuses the whole tx when ANY entry was already reserved, and reserves none of its others", async () => {
      const submitter = workingSubmitter();
      const { server } = await replayServer(submitter);
      expect((await post(server, tx("1001"))).statusCode).toBe(200);

      const mixed = buildInvokeTx([
        { subject: KNOWN_WALLET, nonce: "1002", expiration: SOON },
        { subject: KNOWN_WALLET, nonce: "1001", expiration: SOON },
      ]);
      const refused = await post(server, mixed);
      expect(refused.statusCode).toBe(409);

      // B was NOT left reserved by the refused attempt: its legitimate signer
      // can still submit it.
      expect((await post(server, tx("1002"))).statusCode).toBe(200);
      expect(submitter.submit).toHaveBeenCalledTimes(2);
    });
  });

  describe("reservations are released only when the tx definitely did not land", () => {
    it.each([
      "sponsor_try_again_later",
      "sponsor_simulation_failed",
      "sponsor_bad_tx",
      "sponsor_fee_too_high",
      "sponsor_budget_exceeded",
      "sponsor_submit_failed",
      "relayer_not_configured",
    ])("%s: the same signed tx can be retried", async (code) => {
      const submitter: TransactionSubmitter = {
        submit: vi
          .fn()
          .mockRejectedValueOnce(new SubmissionError("pre-send failure", code))
          .mockResolvedValueOnce({ hash: "retry-ok" }),
      };
      const { server } = await replayServer(submitter);
      const signed = tx("900");

      const failed = await post(server, signed);
      const retried = await post(server, signed);

      expect(failed.statusCode).toBe(502);
      expect(retried.statusCode).toBe(200);
      expect(submitter.submit).toHaveBeenCalledTimes(2);
    });

    it.each(["tx_timeout", "tx_failed", "submission_failed", "txBadSeq", "weird_relayer_code"])(
      "%s: outcome unknown or possibly landed, so the reservation is kept and a retry is refused",
      async (code) => {
        const submitter: TransactionSubmitter = {
          submit: vi.fn().mockRejectedValue(new SubmissionError("maybe landed", code)),
        };
        const { server } = await replayServer(submitter);
        const signed = tx("901");

        expect((await post(server, signed)).statusCode).toBe(502);
        expect((await post(server, signed)).statusCode).toBe(409);
        expect(submitter.submit).toHaveBeenCalledTimes(1);
      },
    );

    it("a non-SubmissionError throw has an unknown outcome: reservation kept", async () => {
      const submitter: TransactionSubmitter = {
        submit: vi.fn().mockRejectedValue(new Error("socket hang up")),
      };
      const { server } = await replayServer(submitter);
      const signed = tx("902");

      expect((await post(server, signed)).statusCode).toBe(502);
      expect((await post(server, signed)).statusCode).toBe(409);
    });

    it("a failing release does not turn a clean refusal into a crash", async () => {
      const guard = createMemoryReplayGuard();
      guard.release = async () => {
        throw new Error("db gone");
      };
      const submitter: TransactionSubmitter = {
        submit: vi.fn().mockRejectedValue(new SubmissionError("pre-send", "sponsor_bad_tx")),
      };
      const { server } = await replayServer(submitter, { replayGuard: guard });

      const res = await post(server, tx("903"));
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("sponsor_bad_tx");
    });
  });

  describe("fails closed", () => {
    it("503 and no submission when the replay store cannot record the reservation", async () => {
      const submitter = workingSubmitter();
      const guard = createMemoryReplayGuard();
      guard.reserve = async () => {
        throw new Error("replay store down");
      };
      const { server } = await replayServer(submitter, { replayGuard: guard });

      const res = await post(server, tx("1"));

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("persistence_unavailable");
      expect(submitter.submit).not.toHaveBeenCalled();
    });

    it("an unscoped tx is rejected (403) BEFORE anything is reserved", async () => {
      const submitter = workingSubmitter();
      const guard = createMemoryReplayGuard();
      const reserve = vi.spyOn(guard, "reserve");
      const { server } = await replayServer(submitter, { replayGuard: guard });

      const res = await post(
        server,
        buildInvokeTx([{ subject: OTHER_CONTRACT, nonce: "1", expiration: SOON }]),
      );

      expect(res.statusCode).toBe(403);
      expect(reserve).not.toHaveBeenCalled();
    });
  });

  describe("signature expiration cap (120 ledgers, approved 2A)", () => {
    it("accepts an entry exactly at latest + 120", async () => {
      const { server } = await replayServer(workingSubmitter());
      expect((await post(server, tx("1", LATEST + 120))).statusCode).toBe(200);
    });

    it("refuses an entry at latest + 121 with a coded 422, before reserving or submitting", async () => {
      const submitter = workingSubmitter();
      const guard = createMemoryReplayGuard();
      const reserve = vi.spyOn(guard, "reserve");
      const { server } = await replayServer(submitter, { replayGuard: guard });

      const res = await post(server, tx("1", LATEST + 121));

      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("auth_expiration_too_far");
      expect(res.json().maxLedgers).toBe(120);
      expect(reserve).not.toHaveBeenCalled();
      expect(submitter.submit).not.toHaveBeenCalled();
    });

    it("refuses the whole tx when only ONE of several entries exceeds the cap", async () => {
      const submitter = workingSubmitter();
      const { server } = await replayServer(submitter);
      const res = await post(
        server,
        buildInvokeTx([
          { subject: KNOWN_WALLET, nonce: "1", expiration: SOON },
          { subject: KNOWN_WALLET, nonce: "2", expiration: LATEST + 9999 },
        ]),
      );
      expect(res.statusCode).toBe(422);
      expect(submitter.submit).not.toHaveBeenCalled();
    });

    it("the cap is configurable per deployment", async () => {
      const { server } = await replayServer(workingSubmitter(), { maxAuthExpirationLedgers: 10 });
      expect((await post(server, tx("1", LATEST + 10))).statusCode).toBe(200);
      expect((await post(server, tx("2", LATEST + 11))).statusCode).toBe(422);
    });

    it("503 and no submission when the latest ledger cannot be read (cannot bound the window)", async () => {
      const submitter = workingSubmitter();
      const { server } = await replayServer(submitter, {
        getLatestLedger: async () => {
          throw new Error("rpc down");
        },
      });

      const res = await post(server, tx("1"));

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("ledger_unavailable");
      expect(submitter.submit).not.toHaveBeenCalled();
    });

    it("an already-expired entry is not capped (the host rejects it at simulation, before any spend)", async () => {
      const { server } = await replayServer(workingSubmitter());
      expect((await post(server, tx("1", LATEST - 5))).statusCode).toBe(200);
    });
  });

  it("audits a refused replay with a fingerprint, never the raw nonce", async () => {
    const { server, audit } = await replayServer(workingSubmitter());
    const signed = tx("123456789012345");
    await post(server, signed);
    await post(server, signed);

    const events = await audit.list();
    const refused = events.find((e) => e.type === "tx.replay_rejected");
    expect(refused).toBeDefined();
    expect(JSON.stringify(refused)).not.toContain("123456789012345");
    expect(refused?.data).toMatchObject({ network: "testnet" });
    expect((refused?.data as { fingerprint: string }).fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("with no networkPassphrase configured (dev), replay checking is off like scoping", async () => {
    const submitter = workingSubmitter();
    app = buildServer({ submitter });
    const signed = tx("1");

    expect((await post(app, signed)).statusCode).toBe(200);
    expect((await post(app, signed)).statusCode).toBe(200);
  });
});
