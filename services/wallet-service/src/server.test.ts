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

    const session = await server.inject({ url: `/wallet/session/${body.sessionId}` });
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

describe("GET /wallet/session/:id", () => {
  it("404s for unknown sessions", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({ url: "/wallet/session/does-not-exist" });
    expect(res.statusCode).toBe(404);
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

describe("session management (§5.1)", () => {
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

  it("lists sessions for an account", async () => {
    const server = build(workingSubmitter());
    const { createSessionId, connectSessionId } = await createAndConnect(server);

    const res = await server.inject({
      url: "/wallet/sessions?contractId=CCONTRACT&network=testnet",
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().sessions.map((s: { id: string }) => s.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(createSessionId);
    expect(ids).toContain(connectSessionId);
  });

  it("returns an empty list for unknown accounts and rejects bad queries", async () => {
    const server = build(workingSubmitter());
    const empty = await server.inject({ url: "/wallet/sessions?contractId=CX&network=testnet" });
    expect(empty.json().sessions).toEqual([]);

    const bad = await server.inject({ url: "/wallet/sessions?network=devnet" });
    expect(bad.statusCode).toBe(400);
  });

  it("revokes a session and audits it", async () => {
    const audit = createMemoryAuditLog();
    const server = build(workingSubmitter(), audit);
    const { connectSessionId } = await createAndConnect(server);

    const revoke = await server.inject({
      method: "DELETE",
      url: `/wallet/session/${connectSessionId}`,
    });
    expect(revoke.statusCode).toBe(204);

    const gone = await server.inject({ url: `/wallet/session/${connectSessionId}` });
    expect(gone.statusCode).toBe(404);
    expect((await audit.list()).map((e) => e.type)).toContain("session.revoked");
  });

  it("404s when revoking a session that doesn't exist", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({ method: "DELETE", url: "/wallet/session/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /health", () => {
  it("responds ok", async () => {
    const server = build(workingSubmitter());
    const res = await server.inject({ url: "/health" });
    expect(res.json()).toEqual({ status: "ok", service: "wallet-service" });
  });
});
