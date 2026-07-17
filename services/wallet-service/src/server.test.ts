import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createMemoryAuditLog, type AuditLog } from "./repository";
import { createUnconfiguredSubmitter, SubmissionError, type TransactionSubmitter } from "./relayer";
import { buildServer } from "./server";

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
