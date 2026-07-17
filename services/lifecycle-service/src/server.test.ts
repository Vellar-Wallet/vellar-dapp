import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AccountReader, HorizonAccount } from "./horizon";
import { buildCleanupPlan } from "./planner";
import { buildServer } from "./server";

const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";
const G2 = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

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
  app = buildServer({ reader });
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
  it("returns no steps for an already-clean account", async () => {
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

  it("builds one parseable unsigned tx covering all blockers, with a stable hash", async () => {
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
    expect("operations" in tx && tx.operations.map((o) => o.type)).toEqual([
      "payment", // USDC to destination
      "changeTrust", // remove USDC trustline
      "manageSellOffer", // cancel offer 42
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
