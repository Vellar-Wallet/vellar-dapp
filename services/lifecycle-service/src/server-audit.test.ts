import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AccountReader, HorizonAccount } from "./horizon";
import { buildServer, fakeFacilitatorClient } from "./server";
import { createMemoryAuditLog } from "./audit";
import { generateRedactionSalt } from "./audit-redaction";

// buildServer() resolves its public resource URL from the environment and
// refuses to fall back to the local bind host. Tests must set a valid value.
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

const SOURCE = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";
const DEST = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function account(overrides: Partial<HorizonAccount> = {}): HorizonAccount {
  return {
    accountId: SOURCE,
    sequence: "103720918407888896",
    balances: [{ assetType: "native", balance: "100.0" }],
    dataKeys: [],
    offers: [],
    openOffers: 0,
    ...overrides,
  };
}

function readerFor(result: HorizonAccount | undefined): AccountReader {
  return { getAccount: async () => result };
}

describe("lifecycle mutating routes audit wiring (#763)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("records an audit event on a successful account merge", async () => {
    const audit = createMemoryAuditLog(generateRedactionSalt());
    app = buildServer({
      reader: readerFor(account()),
      audit,
      x402FacilitatorClient: fakeFacilitatorClient(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/lifecycle/merge",
      payload: { accountId: SOURCE, destination: DEST },
    });

    expect(res.statusCode).toBe(200);
    const events = await audit.list();
    const outcomeEvent = events.find((e) => e.type === "lifecycle.account_merge");
    expect(outcomeEvent).toBeDefined();
    expect((outcomeEvent!.data as Record<string, unknown>).outcome).toBe("success");
  });

  it("still records an audit event when the merge is refused for blockers", async () => {
    const audit = createMemoryAuditLog(generateRedactionSalt());
    app = buildServer({
      reader: readerFor(
        account({
          balances: [
            { assetType: "native", balance: "5.0000000" },
            {
              assetType: "credit_alphanum4",
              assetCode: "USDC",
              assetIssuer: DEST,
              balance: "100.00",
            },
          ],
        }),
      ),
      audit,
      x402FacilitatorClient: fakeFacilitatorClient(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/lifecycle/merge",
      payload: { accountId: SOURCE, destination: DEST },
    });

    expect(res.statusCode).toBe(409);
    const events = await audit.list();
    const outcomeEvent = events.find((e) => e.type === "lifecycle.account_merge");
    expect(outcomeEvent).toBeDefined();
    expect((outcomeEvent!.data as Record<string, unknown>).outcome).toBe("not_merge_ready");
  });

  it("still records an audit event when the merge fails partway through", async () => {
    const audit = createMemoryAuditLog(generateRedactionSalt());
    // A mutating step after the plan is built (cache invalidation) throws.
    const reader: AccountReader & { invalidate: (id: string) => void } = {
      getAccount: async (id: string) => (id === SOURCE ? account() : account({ accountId: DEST })),
      // invalidate() is synchronous and fire-and-forget in the merge handler,
      // so a sync throw is what simulates a failure after the plan is built.
      invalidate: () => {
        throw new Error("cache unavailable");
      },
    };
    app = buildServer({
      reader,
      audit,
      x402FacilitatorClient: fakeFacilitatorClient(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/lifecycle/merge",
      payload: { accountId: SOURCE, destination: DEST },
    });

    expect(res.statusCode).toBe(500);
    // The action failed, but the attempt is still audited.
    const events = await audit.list();
    const outcomeEvent = events.find((e) => e.type === "lifecycle.account_merge");
    expect(outcomeEvent).toBeDefined();
    expect((outcomeEvent!.data as Record<string, unknown>).outcome).toBe("failure");
  });

  it("does not fail the merge when the audit backend itself throws", async () => {
    const audit = createMemoryAuditLog(generateRedactionSalt());
    audit.record = async () => {
      throw new Error("audit down");
    };
    app = buildServer({
      reader: readerFor(account()),
      audit,
      x402FacilitatorClient: fakeFacilitatorClient(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/lifecycle/merge",
      payload: { accountId: SOURCE, destination: DEST },
    });

    expect(res.statusCode).toBe(200);
  });
});
