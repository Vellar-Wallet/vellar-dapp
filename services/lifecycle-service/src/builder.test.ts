import { describe, expect, it } from "vitest";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  buildCleanupSteps,
  buildMergeStep,
  createPlanTracking,
  recordStepConfirmation,
  resumeCleanupPlan,
  OPS_PER_TX,
} from "./builder";
import type { HorizonAccount } from "./horizon";

const PASSPHRASE = "Test SDF Network ; September 2015";
const DEST = Keypair.random().publicKey();

function account(overrides: Partial<HorizonAccount> = {}): HorizonAccount {
  return {
    accountId: Keypair.random().publicKey(),
    sequence: "100",
    balances: [{ assetType: "native", balance: "100.0" }],
    dataKeys: [],
    offers: [],
    openOffers: 0,
    ...overrides,
  };
}

/** Decode a step's XDR and return its op count + sequence. */
function decode(xdr: string) {
  const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
  if ("innerTransaction" in tx) throw new Error("unexpected fee-bump tx");
  return { ops: tx.operations.length, sequence: BigInt(tx.sequence) };
}

/** Decode a step's XDR and return its ordered op types. */
function opTypes(xdr: string): string[] {
  const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
  if ("innerTransaction" in tx) throw new Error("unexpected fee-bump tx");
  return tx.operations.map((o) => o.type);
}

const dataKeys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);

describe("buildCleanupSteps (L6 op-split)", () => {
  it("returns no steps for a clean native-only account", () => {
    expect(buildCleanupSteps(account(), DEST, PASSPHRASE)).toEqual([]);
  });

  it("keeps a sub-limit account in a single transaction", () => {
    const steps = buildCleanupSteps(account({ dataKeys: dataKeys(10) }), DEST, PASSPHRASE);
    expect(steps).toHaveLength(1);
    expect(decode(steps[0]!.xdr).ops).toBe(10);
  });

  it("never emits more than OPS_PER_TX operations in any transaction", () => {
    // 250 data-delete ops must split across ceil(250/100) = 3 transactions.
    const steps = buildCleanupSteps(account({ dataKeys: dataKeys(250) }), DEST, PASSPHRASE);
    expect(steps).toHaveLength(3);
    for (const s of steps) expect(decode(s.xdr).ops).toBeLessThanOrEqual(OPS_PER_TX);
    const total = steps.reduce((n, s) => n + decode(s.xdr).ops, 0);
    expect(total).toBe(250);
  });

  it("gives split transactions CONSECUTIVE sequence numbers so they submit in order", () => {
    const steps = buildCleanupSteps(account({ dataKeys: dataKeys(250) }), DEST, PASSPHRASE);
    const seqs = steps.map((s) => decode(s.xdr).sequence);
    // sequence starts at account.sequence + 1 and increments by exactly 1.
    expect(seqs[0]).toBe(101n);
    expect(seqs[1]).toBe(102n);
    expect(seqs[2]).toBe(103n);
  });

  it("counts a non-zero balance as TWO ops (payment + trustline removal)", () => {
    const steps = buildCleanupSteps(
      account({
        balances: [
          { assetType: "native", balance: "5.0" },
          { assetType: "credit_alphanum4", assetCode: "USDC", assetIssuer: DEST, balance: "12.5" },
        ],
      }),
      DEST,
      PASSPHRASE,
    );
    expect(steps).toHaveLength(1);
    expect(decode(steps[0]!.xdr).ops).toBe(2);
  });

  it("distinct step titles when split, so the wizard can label each", () => {
    const steps = buildCleanupSteps(account({ dataKeys: dataKeys(150) }), DEST, PASSPHRASE);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.title).not.toBe(steps[1]!.title);
  });
});

describe("buildCleanupSteps — offer/liability ordering (RA-5)", () => {
  const USDC = { assetType: "credit_alphanum4", assetCode: "USDC", assetIssuer: DEST };

  it("cancels offers BEFORE paying out balances (frees selling liabilities first)", () => {
    // An account holding 100 USDC AND selling 40 USDC on an open offer: 40 is a
    // selling liability, so only 60 is spendable. If the payment of the full 100
    // ran before the cancel it would op_underfunded. The cancel must come first.
    const steps = buildCleanupSteps(
      account({
        balances: [
          { assetType: "native", balance: "100.0" },
          { ...USDC, balance: "100" },
        ],
        offers: [
          {
            id: "7",
            sellingAssetType: "credit_alphanum4",
            sellingAssetCode: "USDC",
            sellingAssetIssuer: DEST,
            buyingAssetType: "native",
            price: "1.0",
          },
        ],
        openOffers: 1,
      }),
      DEST,
      PASSPHRASE,
    );
    expect(steps).toHaveLength(1);
    const types = opTypes(steps[0]!.xdr);
    // Order: cancel the offer, THEN pay the balance, THEN remove the trustline.
    expect(types).toEqual(["manageSellOffer", "payment", "changeTrust"]);
    // Specifically: every manageSellOffer precedes every payment.
    const lastCancel = types.lastIndexOf("manageSellOffer");
    const firstPayment = types.indexOf("payment");
    expect(lastCancel).toBeLessThan(firstPayment);
  });

  it("orders cancels before payments even across MANY offers and balances", () => {
    const steps = buildCleanupSteps(
      account({
        balances: [
          { assetType: "native", balance: "50.0" },
          { ...USDC, balance: "10" },
          { assetType: "credit_alphanum4", assetCode: "EURC", assetIssuer: DEST, balance: "5" },
        ],
        offers: [
          {
            id: "1",
            sellingAssetType: "credit_alphanum4",
            sellingAssetCode: "USDC",
            sellingAssetIssuer: DEST,
            buyingAssetType: "native",
            price: "1",
          },
          {
            id: "2",
            sellingAssetType: "credit_alphanum4",
            sellingAssetCode: "EURC",
            sellingAssetIssuer: DEST,
            buyingAssetType: "native",
            price: "1",
          },
        ],
        openOffers: 2,
      }),
      DEST,
      PASSPHRASE,
    );
    const types = opTypes(steps[0]!.xdr);
    const lastCancel = types.lastIndexOf("manageSellOffer");
    const firstPayment = types.indexOf("payment");
    expect(firstPayment).toBeGreaterThan(lastCancel);
  });
});

describe("buildMergeStep", () => {
  it("uses the account's next sequence and merges to the destination", () => {
    const acct = account({ sequence: "500" });
    const step = buildMergeStep(acct, DEST, PASSPHRASE);
    expect(decode(step.xdr).ops).toBe(1);
    expect(decode(step.xdr).sequence).toBe(501n);
  });
});

describe("Issue #530: Multi-step cleanup confirmation tracking & resume path", () => {
  it("tracks per-step confirmation state and records confirmations by index or hash", () => {
    const acct = account({ dataKeys: dataKeys(250) }); // 3 steps: 100, 100, 50
    const steps = buildCleanupSteps(acct, DEST, PASSPHRASE);
    expect(steps).toHaveLength(3);

    let tracking = createPlanTracking(acct, DEST, steps);
    expect(tracking.totalSteps).toBe(3);
    expect(tracking.steps[0]?.confirmed).toBe(false);
    expect(tracking.steps[1]?.confirmed).toBe(false);
    expect(tracking.steps[2]?.confirmed).toBe(false);

    // Confirm step 0 by index
    tracking = recordStepConfirmation(tracking, 0);
    expect(tracking.steps[0]?.confirmed).toBe(true);
    expect(tracking.steps[0]?.confirmedAt).toBeDefined();

    // Confirm step 1 by hash
    tracking = recordStepConfirmation(tracking, steps[1]!.hash);
    expect(tracking.steps[1]?.confirmed).toBe(true);
    expect(tracking.steps[2]?.confirmed).toBe(false);
  });

  it("happy path: resumes from step 2 after steps 0 and 1 confirmed, rebuilding only unconfirmed steps", () => {
    const acct = account({ sequence: "100", dataKeys: dataKeys(250) });
    const steps = buildCleanupSteps(acct, DEST, PASSPHRASE);
    expect(steps).toHaveLength(3);

    let tracking = createPlanTracking(acct, DEST, steps);
    // Confirm step 0 and step 1
    tracking = recordStepConfirmation(tracking, 0);
    tracking = recordStepConfirmation(tracking, 1);

    // After step 0 and step 1 submit on-chain, sequence is now 102, and remaining dataKeys are k200..k249 (50 keys)
    const onChainAccount = account({
      accountId: acct.accountId,
      sequence: "102",
      dataKeys: dataKeys(250).slice(200), // remaining 50 keys
    });

    const result = resumeCleanupPlan({
      currentAccount: onChainAccount,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("resumed");
    if (result.status === "resumed") {
      expect(result.resumedFromStep).toBe(2);
      expect(result.completedStepCount).toBe(2);
      expect(result.totalSteps).toBe(3);
      expect(result.remainingSteps).toHaveLength(1);
      // Sequence of remaining step starts at 103 (102 + 1)
      expect(decode(result.remainingSteps[0]!.xdr).sequence).toBe(103n);
      expect(decode(result.remainingSteps[0]!.xdr).ops).toBe(50);
    }
  });

  it("failure mode: requires fresh plan when an earlier step's on-chain trustline balance changed", () => {
    const USDC = { assetType: "credit_alphanum4", assetCode: "USDC", assetIssuer: DEST };
    const acct = account({
      sequence: "100",
      balances: [
        { assetType: "native", balance: "100.0" },
        { ...USDC, balance: "50" },
      ],
      dataKeys: dataKeys(150),
    });
    const steps = buildCleanupSteps(acct, DEST, PASSPHRASE);
    let tracking = createPlanTracking(acct, DEST, steps);

    // Step 0 confirmed
    tracking = recordStepConfirmation(tracking, 0);

    // But on-chain, someone unexpectedly transferred more USDC or balance changed from 50 to 100
    const changedAccount = account({
      accountId: acct.accountId,
      sequence: "101",
      balances: [
        { assetType: "native", balance: "100.0" },
        { ...USDC, balance: "100" }, // Changed!
      ],
      dataKeys: dataKeys(150),
    });

    const result = resumeCleanupPlan({
      currentAccount: changedAccount,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("fresh_plan_required");
    if (result.status === "fresh_plan_required") {
      expect(result.reason).toContain("trustline balance");
      expect(result.reason).toContain("changed");
    }
  });

  it("failure mode: requires fresh plan when a brand-new unexpected trustline appears on-chain", () => {
    const acct = account({ dataKeys: dataKeys(150) });
    const steps = buildCleanupSteps(acct, DEST, PASSPHRASE);
    let tracking = createPlanTracking(acct, DEST, steps);
    tracking = recordStepConfirmation(tracking, 0);

    // New unexpected trustline balance appears
    const changedAccount = account({
      accountId: acct.accountId,
      sequence: "101",
      balances: [
        { assetType: "native", balance: "100.0" },
        { assetType: "credit_alphanum4", assetCode: "NEWCOIN", assetIssuer: DEST, balance: "10" },
      ],
      dataKeys: dataKeys(50),
    });

    const result = resumeCleanupPlan({
      currentAccount: changedAccount,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("fresh_plan_required");
    if (result.status === "fresh_plan_required") {
      expect(result.reason).toContain("unexpected new asset");
    }
  });

  it("failure mode: requires fresh plan if step confirmation order has non-contiguous gaps", () => {
    const acct = account({ dataKeys: dataKeys(250) });
    const steps = buildCleanupSteps(acct, DEST, PASSPHRASE);
    let tracking = createPlanTracking(acct, DEST, steps);

    // Step 1 marked confirmed before step 0
    tracking = recordStepConfirmation(tracking, 1);

    const result = resumeCleanupPlan({
      currentAccount: acct,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("fresh_plan_required");
    if (result.status === "fresh_plan_required") {
      expect(result.reason).toContain("Non-contiguous");
    }
  });

  it("completion: returns completed when all steps have been confirmed", () => {
    const acct = account({ dataKeys: dataKeys(50) });
    const steps = buildCleanupSteps(acct, DEST, PASSPHRASE);
    expect(steps).toHaveLength(1);

    let tracking = createPlanTracking(acct, DEST, steps);
    tracking = recordStepConfirmation(tracking, 0);

    const result = resumeCleanupPlan({
      currentAccount: acct,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("completed");
  });
});

describe("Issue #830: resuming into a step that now needs splitting", () => {
  const USDC = { assetType: "credit_alphanum4", assetCode: "USDC", assetIssuer: DEST };
  const keys = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => `k${from + i}`);

  /** A 150-entry plan (two steps: 100 + 50) whose first step is confirmed. */
  function confirmedFirstStep() {
    const acct = account({ sequence: "100", dataKeys: keys(0, 150) });
    const steps = buildCleanupSteps(acct, DEST, PASSPHRASE);
    expect(steps.map((s) => decode(s.xdr).ops)).toEqual([100, 50]);
    const tracking = recordStepConfirmation(createPlanTracking(acct, DEST, steps), 0);
    return { acct, steps, tracking };
  }

  /** The account after step 0 landed, with `extra` more data entries added meanwhile. */
  function afterStepZero(acct: HorizonAccount, extra: string[]) {
    return account({
      accountId: acct.accountId,
      sequence: "101",
      dataKeys: [...keys(100, 150), ...extra],
    });
  }

  it("rebuilds the remaining work as two steps when one step has grown past the op limit", () => {
    const { acct, steps, tracking } = confirmedFirstStep();
    const onChain = afterStepZero(acct, keys(1000, 1090)); // 50 + 90 = 140 operations

    const result = resumeCleanupPlan({
      currentAccount: onChain,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("resumed");
    if (result.status !== "resumed") return;
    expect(result.resumedFromStep).toBe(1);
    expect(result.remainingSteps).toHaveLength(2); // the plan had one step left; it now needs two
    expect(result.remainingSteps.map((s) => decode(s.xdr).ops)).toEqual([100, 40]);
    // The rebuilt steps replace, not extend, the stale one.
    expect(result.remainingSteps.map((s) => s.hash)).not.toContain(steps[1]!.hash);
  });

  it("keeps the step count honest: completed plus remaining is the new total", () => {
    const { acct, tracking } = confirmedFirstStep();
    const onChain = afterStepZero(acct, keys(1000, 1090));

    const result = resumeCleanupPlan({
      currentAccount: onChain,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("resumed");
    if (result.status !== "resumed") return;
    expect(result.completedStepCount + result.remainingSteps.length).toBe(result.totalSteps);
    expect(result.totalSteps).toBe(3);
  });

  it("numbers the rebuilt steps from the account's current sequence, consecutively", () => {
    const { acct, tracking } = confirmedFirstStep();
    const onChain = afterStepZero(acct, keys(1000, 1090));

    const result = resumeCleanupPlan({
      currentAccount: onChain,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("resumed");
    if (result.status !== "resumed") return;
    expect(result.remainingSteps.map((s) => decode(s.xdr).sequence)).toEqual([102n, 103n]);
  });

  it("labels the rebuilt steps by the new count, not the original one", () => {
    const { acct, tracking } = confirmedFirstStep();
    const onChain = afterStepZero(acct, keys(1000, 1090));

    const result = resumeCleanupPlan({
      currentAccount: onChain,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("resumed");
    if (result.status !== "resumed") return;
    expect(result.remainingSteps[0]!.title).toBe("Clean up the account (1/2)");
    expect(result.remainingSteps[1]!.title).toBe("Clean up the account (2/2)");
  });

  it("carries every remaining operation exactly once and none from the confirmed step", () => {
    const { acct, tracking } = confirmedFirstStep();
    const added = keys(1000, 1090);
    const onChain = afterStepZero(acct, added);

    const result = resumeCleanupPlan({
      currentAccount: onChain,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("resumed");
    if (result.status !== "resumed") return;
    const names = result.remainingSteps.flatMap((s) => {
      const tx = TransactionBuilder.fromXDR(s.xdr, PASSPHRASE);
      if ("innerTransaction" in tx) throw new Error("unexpected fee-bump tx");
      return tx.operations.map((o) => (o.type === "manageData" ? o.name : o.type));
    });
    expect(names).toEqual([...keys(100, 150), ...added]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("k0");
    expect(names).not.toContain("k99");
  });

  it("splits in dependency order: payments and trustline removals stay before data deletions", () => {
    const acct = account({
      sequence: "100",
      balances: [
        { assetType: "native", balance: "100.0" },
        { ...USDC, balance: "50" },
      ],
      dataKeys: keys(0, 60),
    });
    const steps = buildCleanupSteps(acct, DEST, PASSPHRASE);
    expect(steps).toHaveLength(1); // 2 trustline ops + 60 data = 62
    const tracking = createPlanTracking(acct, DEST, steps);

    const onChain = account({
      accountId: acct.accountId,
      sequence: "100",
      balances: acct.balances,
      dataKeys: keys(0, 140), // grew while the plan waited: 2 + 140 = 142 operations
    });
    const result = resumeCleanupPlan({
      currentAccount: onChain,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("resumed");
    if (result.status !== "resumed") return;
    expect(result.remainingSteps).toHaveLength(2);
    const types = result.remainingSteps.flatMap((s) => opTypes(s.xdr));
    expect(types.slice(0, 2)).toEqual(["payment", "changeTrust"]);
    expect(types.slice(2).every((t) => t === "manageData")).toBe(true);
  });

  it("does the same when nothing was confirmed yet", () => {
    const acct = account({ sequence: "100", dataKeys: keys(0, 90) });
    const steps = buildCleanupSteps(acct, DEST, PASSPHRASE);
    expect(steps).toHaveLength(1);
    const tracking = createPlanTracking(acct, DEST, steps);

    const result = resumeCleanupPlan({
      currentAccount: account({
        accountId: acct.accountId,
        sequence: "100",
        dataKeys: keys(0, 130),
      }),
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("resumed");
    if (result.status !== "resumed") return;
    expect(result.resumedFromStep).toBe(0);
    expect(result.remainingSteps.map((s) => decode(s.xdr).ops)).toEqual([100, 30]);
    expect(result.totalSteps).toBe(2);
  });

  it("a step that shrinks is reported the same way: the total follows the rebuild", () => {
    const { acct, tracking } = confirmedFirstStep();
    const onChain = account({
      accountId: acct.accountId,
      sequence: "101",
      dataKeys: keys(100, 110), // most of the remaining entries were removed elsewhere
    });

    const result = resumeCleanupPlan({
      currentAccount: onChain,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("resumed");
    if (result.status !== "resumed") return;
    expect(result.remainingSteps.map((s) => decode(s.xdr).ops)).toEqual([10]);
    expect(result.completedStepCount + result.remainingSteps.length).toBe(result.totalSteps);
  });

  it("refuses to split silently when the cause is a new trustline: that needs a fresh plan", () => {
    const { acct, tracking } = confirmedFirstStep();
    const onChain = account({
      accountId: acct.accountId,
      sequence: "101",
      balances: [
        { assetType: "native", balance: "100.0" },
        { ...USDC, balance: "0" }, // a trustline that was not in the plan
      ],
      dataKeys: keys(100, 150),
    });

    const result = resumeCleanupPlan({
      currentAccount: onChain,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("fresh_plan_required");
    if (result.status !== "fresh_plan_required") return;
    expect(result.reason).toContain("unexpected new asset trustline");
  });

  it("never emits an over-limit transaction, however much the account grew", () => {
    const { acct, tracking } = confirmedFirstStep();
    const onChain = afterStepZero(acct, keys(1000, 1450)); // 500 operations left

    const result = resumeCleanupPlan({
      currentAccount: onChain,
      destination: DEST,
      networkPassphrase: PASSPHRASE,
      tracking,
    });

    expect(result.status).toBe("resumed");
    if (result.status !== "resumed") return;
    expect(result.remainingSteps).toHaveLength(5);
    for (const s of result.remainingSteps) {
      expect(decode(s.xdr).ops).toBeLessThanOrEqual(OPS_PER_TX);
    }
  });
});
