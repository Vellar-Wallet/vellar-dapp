import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AccountReader, HorizonAccount } from "./horizon";
import { buildCleanupPlan } from "./planner";
import { buildServer, fakeFacilitatorClient } from "./server";

const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";
const G2 = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

// buildServer() calls publicBaseUrlFromEnv() at construction time (see
// docs/decisions.md — this fails-closed on purpose so a missing public URL
// never falls back to publishing an internal bind address). Tests need a
// real, valid value in the environment for that call to succeed.
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

function account(overrides: Partial<HorizonAccount> = {}): HorizonAccount {
  return {
    accountId: G1,
    sequence: "103720918407888896",
    balances: [{ assetType: "native", balance: "100.0" }],
    dataKeys: [],
    offers: [],
    openOffers: 0,
    ...overrides,
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(result: HorizonAccount | undefined) {
  const reader: AccountReader = { getAccount: vi.fn().mockResolvedValue(result) };
  app = buildServer({ reader, x402FacilitatorClient: fakeFacilitatorClient() });
  return app;
}

describe("buildCleanupPlan", () => {
  it("clean native-only account is merge-ready in one transaction", () => {
    const plan = buildCleanupPlan(account(), G2);
    expect(plan).toEqual({
      accountId: G1,
      destination: G2,
      blockers: [],
      estimatedTransactions: 1,
      mergeReady: true,
    });
  });

  it("reports every blocker category with explicit actions", () => {
    const plan = buildCleanupPlan(
      account({
        balances: [
          { assetType: "native", balance: "5.0" },
          { assetType: "credit_alphanum4", assetCode: "USDC", assetIssuer: G2, balance: "12.5" },
          {
            assetType: "credit_alphanum4",
            assetCode: "EURC",
            assetIssuer: G2,
            balance: "0.0000000",
          },
        ],
        dataKeys: ["config"],
        openOffers: 2,
      }),
      G2,
    );

    const types = plan.blockers.map((b) => b.type).sort();
    // USDC: balance + trustline; EURC (zero balance): trustline only; offers; data.
    expect(types).toEqual(["balance", "data", "offer", "trustline", "trustline"]);
    expect(plan.mergeReady).toBe(false);
    expect(plan.estimatedTransactions).toBe(2); // one batch of cleanup ops + the merge
    const usdcBalance = plan.blockers.find((b) => b.type === "balance");
    expect(usdcBalance?.actionRequired).toMatch(/transfer or burn/i);
  });

  it("estimates cleanup transactions from the real op count, not blocker count (L6)", () => {
    // 150 open offers = 150 cancel OPS = 2 cleanup txs (ceil(150/100)) + 1 merge.
    // The old estimate counted offers as a single blocker and under-reported 2.
    const plan = buildCleanupPlan(account({ openOffers: 150 }), G2);
    expect(plan.estimatedTransactions).toBe(3);
  });

  it("counts a non-zero balance as two ops (transfer + trustline) in the estimate", () => {
    // 100 non-zero token balances = 200 ops = 2 cleanup txs + 1 merge.
    const balances = [
      { assetType: "native", balance: "10.0" },
      ...Array.from({ length: 100 }, (_, i) => ({
        assetType: "credit_alphanum4",
        assetCode: `T${i}`,
        assetIssuer: G2,
        balance: "1.0",
      })),
    ];
    const plan = buildCleanupPlan(account({ balances }), G2);
    expect(plan.estimatedTransactions).toBe(3);
  });
});

describe("POST /lifecycle/inspect", () => {
  it("returns the inspected account", async () => {
    const server = build(account());
    const res = await server.inject({
      method: "POST",
      url: "/lifecycle/inspect",
      payload: { accountId: G1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.accountId).toBe(G1);
  });

  it("404s for accounts not on the network", async () => {
    const server = build(undefined);
    const res = await server.inject({
      method: "POST",
      url: "/lifecycle/inspect",
      payload: { accountId: G1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects contract addresses — smart wallets cannot be merged", async () => {
    const server = build(account());
    const res = await server.inject({
      method: "POST",
      url: "/lifecycle/inspect",
      payload: { accountId: "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_classic_account");
  });

  it("rejects invalid bodies", async () => {
    const server = build(account());
    const res = await server.inject({ method: "POST", url: "/lifecycle/inspect", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /lifecycle/plan", () => {
  it("returns a CleanupPlan for a valid pair", async () => {
    const server = build(account());
    const res = await server.inject({
      method: "POST",
      url: "/lifecycle/plan",
      payload: { accountId: G1, destination: G2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan.mergeReady).toBe(true);
  });

  it("rejects a self-merge and non-classic destinations", async () => {
    const server = build(account());
    const self = await server.inject({
      method: "POST",
      url: "/lifecycle/plan",
      payload: { accountId: G1, destination: G1 },
    });
    expect(self.statusCode).toBe(400);

    const contract = await server.inject({
      method: "POST",
      url: "/lifecycle/plan",
      payload: {
        accountId: G1,
        destination: "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67",
      },
    });
    expect(contract.statusCode).toBe(400);
    expect(contract.json().error).toBe("invalid_destination");
  });

  it("404s when the source account does not exist", async () => {
    const server = build(undefined);
    const res = await server.inject({
      method: "POST",
      url: "/lifecycle/plan",
      payload: { accountId: G1, destination: G2 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /lifecycle/execute", () => {
  it("requires x402 payment (402 without a valid X-PAYMENT header)", async () => {
    const server = build(account());
    const res = await server.inject({
      method: "POST",
      url: "/lifecycle/execute",
      payload: { accountId: G1, destination: G2 },
    });
    expect(res.statusCode).toBe(402);
  });

  // KNOWN GAP: the tests below assert on handler internals (empty-steps
  // shortcut, hash stability of the generated tx) that are unreachable via
  // app.inject() now that paymentMiddleware gates the route — there is no
  // in-process way to satisfy the x402 challenge with a signed payment.
  // Skipped rather than deleted or faked green; see docs/decisions.md.
  it.skip("returns no steps for an already-clean account", async () => {
    const server = build(account());
    const res = await server.inject({
      method: "POST",
      url: "/lifecycle/execute",
      payload: { accountId: G1, destination: G2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().steps).toEqual([]);
    expect(res.json().plan.mergeReady).toBe(true);
  });

  it.skip("builds one parseable unsigned tx covering all blockers, with a stable hash", async () => {
    const { TransactionBuilder, Networks } = await import("@stellar/stellar-sdk");
    const server = build(
      account({
        balances: [
          { assetType: "native", balance: "5.0" },
          { assetType: "credit_alphanum4", assetCode: "USDC", assetIssuer: G2, balance: "12.5" },
        ],
        dataKeys: ["config"],
        offers: [
          {
            id: "42",
            sellingAssetType: "native",
            buyingAssetType: "credit_alphanum4",
            buyingAssetCode: "USDC",
            buyingAssetIssuer: G2,
            price: "2.5",
          },
        ],
        openOffers: 1,
      }),
    );
    const res = await server.inject({
      method: "POST",
      url: "/lifecycle/execute",
      payload: { accountId: G1, destination: G2 },
    });
    expect(res.statusCode).toBe(200);
    const [step] = res.json().steps;
    expect(step.hash).toMatch(/^[0-9a-f]{64}$/);

    const tx = TransactionBuilder.fromXDR(step.xdr, Networks.TESTNET);
    // RA-5: offer cancels come FIRST — cancelling frees any selling liabilities
    // so the subsequent payment can move the full asset balance without hitting
    // op_underfunded. Payments then precede their trustline removals.
    expect("operations" in tx && tx.operations.map((o) => o.type)).toEqual([
      "manageSellOffer", // cancel offer 42 (frees liabilities first)
      "payment", // USDC to destination
      "changeTrust", // remove USDC trustline
      "manageData", // delete "config"
    ]);
    expect(tx.signatures).toHaveLength(0); // UNSIGNED — user signs externally
    expect(tx.hash().toString("hex")).toBe(step.hash);
  });
});

describe("POST /lifecycle/merge", () => {
  it("refuses with 409 + plan while blockers remain", async () => {
    const server = build(
      account({
        balances: [
          { assetType: "native", balance: "5.0" },
          { assetType: "credit_alphanum4", assetCode: "USDC", assetIssuer: G2, balance: "1" },
        ],
      }),
    );
    const res = await server.inject({
      method: "POST",
      url: "/lifecycle/merge",
      payload: { accountId: G1, destination: G2 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().plan.mergeReady).toBe(false);
  });

  it("builds the unsigned accountMerge when clean", async () => {
    const { TransactionBuilder, Networks } = await import("@stellar/stellar-sdk");
    const server = build(account());
    const res = await server.inject({
      method: "POST",
      url: "/lifecycle/merge",
      payload: { accountId: G1, destination: G2 },
    });
    expect(res.statusCode).toBe(200);
    const tx = TransactionBuilder.fromXDR(res.json().step.xdr, Networks.TESTNET);
    expect("operations" in tx && tx.operations[0]?.type).toBe("accountMerge");
    expect(res.json().step.description).toMatch(/cannot be undone/i);
  });
});

describe("x402 public resource URL guard (docs/decisions.md — localhost catalog incident)", () => {
  it("buildServer() refuses to start when no public base URL is configured", () => {
    const previous = process.env.RENDER_EXTERNAL_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    try {
      const reader: AccountReader = { getAccount: vi.fn() };
      expect(() => buildServer({ reader, x402FacilitatorClient: fakeFacilitatorClient() })).toThrow(
        /No public base URL configured/,
      );
    } finally {
      if (previous === undefined) delete process.env.RENDER_EXTERNAL_URL;
      else process.env.RENDER_EXTERNAL_URL = previous;
    }
  });

  it("buildServer() refuses to start when RENDER_EXTERNAL_URL is the exact localhost value from the incident", () => {
    const previous = process.env.RENDER_EXTERNAL_URL;
    // "http://localhost:4002" — verbatim what actually got published to the
    // public Bazaar catalog. Rejected on the https check first (it's also
    // not https), which is fine: the point is buildServer() refuses to boot
    // with it either way. The loopback-specific message is covered directly
    // against validatePublicResourceUrl() in x402-resource-url.test.ts.
    process.env.RENDER_EXTERNAL_URL = "http://localhost:4002";
    try {
      const reader: AccountReader = { getAccount: vi.fn() };
      expect(() => buildServer({ reader, x402FacilitatorClient: fakeFacilitatorClient() })).toThrow(
        /localhost:4002/,
      );
    } finally {
      if (previous === undefined) delete process.env.RENDER_EXTERNAL_URL;
      else process.env.RENDER_EXTERNAL_URL = previous;
    }
  });

  it("buildServer() refuses to start when RENDER_EXTERNAL_URL is https but still a loopback host", () => {
    const previous = process.env.RENDER_EXTERNAL_URL;
    process.env.RENDER_EXTERNAL_URL = "https://localhost:4002";
    try {
      const reader: AccountReader = { getAccount: vi.fn() };
      expect(() => buildServer({ reader, x402FacilitatorClient: fakeFacilitatorClient() })).toThrow(
        /loopback\/local/,
      );
    } finally {
      if (previous === undefined) delete process.env.RENDER_EXTERNAL_URL;
      else process.env.RENDER_EXTERNAL_URL = previous;
    }
  });

  it("registers the real public URL (not localhost) when configured correctly", () => {
    const app = build(account());
    // Same shape @x402/fastify publishes: a 402 challenge without a payment
    // header, whose resource.url must be the public base, not the bind host.
    return app
      .inject({
        method: "POST",
        url: "/lifecycle/execute",
        payload: { accountId: G1, destination: G2 },
      })
      .then((res) => {
        expect(res.statusCode).toBe(402);
        const challengeB64 = res.headers["payment-required"] as string;
        const challenge = JSON.parse(Buffer.from(challengeB64, "base64").toString("utf8"));
        expect(challenge.resource.url).toBe(
          "https://vellar-backend.onrender.com/lifecycle/execute",
        );
        expect(challenge.resource.url).not.toContain("localhost");
      });
  });
});
