import { describe, expect, it, vi } from "vitest";
import {
  initialMintState,
  isMintBusy,
  mintReducer,
  runMint,
  summarizeMintConfig,
  type MintConfig,
  type MintEffects,
  type MintEvent,
  type MintState,
} from "./agent-mint";

const config: MintConfig = {
  token: "CTOKEN",
  tokenSymbol: "XLM",
  amountBaseUnits: "100000000",
  windowSeconds: 86_400,
  expiresAtSeconds: 1_800_000_000,
  network: "testnet",
};
const key = { publicKey: "GAGENT", secret: "SSECRET" };

function play(events: MintEvent[], from: MintState = initialMintState): MintState {
  return events.reduce(mintReducer, from);
}

const happyPath: MintEvent[] = [
  { type: "START", config },
  { type: "KEY_CREATED", key },
  { type: "POLICY_DEPLOYED", policyContractId: "CPOLICY" },
  { type: "DETAILS_CONFIRMED" },
  { type: "PASSKEY_APPROVED", for: "attach-policy" },
  { type: "POLICY_ATTACHED", hash: "attachtx" },
  { type: "SIGNER_ADDED", hash: "addtx" },
  { type: "CONFIRMED" },
];

describe("mintReducer", () => {
  it("walks the full sequence to success and carries the secret for a one-time reveal", () => {
    const steps = happyPath.map((_, i) => play(happyPath.slice(0, i + 1)).step);
    expect(steps).toEqual([
      "creating-key",
      "policy-creation",
      "awaiting-confirmation",
      "awaiting-passkey-approval",
      "attaching-policy",
      "adding-signer",
      "confirming",
      "success",
    ]);
    const done = play(happyPath);
    expect(done).toMatchObject({
      step: "success",
      publicKey: "GAGENT",
      secret: "SSECRET",
      policyContractId: "CPOLICY",
      attachTxHash: "attachtx",
      addSignerTxHash: "addtx",
    });
  });

  it("DISMISS_SECRET drops the secret and nothing can bring it back", () => {
    const done = play(happyPath);
    const dismissed = mintReducer(done, { type: "DISMISS_SECRET" });
    expect(dismissed.step).toBe("success");
    expect("secret" in dismissed && dismissed.secret).toBeFalsy();
    // Replaying any event on the dismissed state never re-exposes it.
    for (const e of happyPath) {
      const s = mintReducer(dismissed, e);
      expect("secret" in s && s.secret).toBeFalsy();
    }
  });

  it("ignores out-of-order events (a late effect cannot corrupt the flow)", () => {
    expect(play([{ type: "CONFIRMED" }])).toEqual(initialMintState);
    expect(
      play([
        { type: "START", config },
        { type: "SIGNER_ADDED", hash: "x" },
      ]).step,
    ).toBe("creating-key");
    // Approval for the wrong prompt is not an approval.
    const awaiting = play(happyPath.slice(0, 4));
    expect(mintReducer(awaiting, { type: "PASSKEY_APPROVED", for: "add-signer" })).toBe(awaiting);
  });

  it("the passkey prompt cannot be skipped: no path from policy-creation to attaching-policy without approval", () => {
    const deployed = play(happyPath.slice(0, 3));
    expect(deployed.step).toBe("awaiting-confirmation");
    // Policy attached without confirmation or approval is ignored.
    expect(mintReducer(deployed, { type: "POLICY_ATTACHED", hash: "h" })).toBe(deployed);
    const confirmed = play(happyPath.slice(0, 4));
    expect(confirmed.step).toBe("awaiting-passkey-approval");
    expect(mintReducer(confirmed, { type: "POLICY_ATTACHED", hash: "h" })).toBe(confirmed);
  });

  it("confirmation cannot be skipped: policy-approval is ignored until DETAILS_CONFIRMED", () => {
    const deployed = play(happyPath.slice(0, 3));
    expect(mintReducer(deployed, { type: "PASSKEY_APPROVED", for: "attach-policy" })).toBe(
      deployed,
    );
  });

  it.each([
    ["creating-key", 1],
    ["policy-creation", 2],
    ["awaiting-confirmation", 3],
    ["attaching-policy", 5],
    ["adding-signer", 6],
  ] as const)(
    "FAIL at %s records the stage; the signer is not reported as existing",
    (stage, n) => {
      const s = mintReducer(play(happyPath.slice(0, n)), { type: "FAIL", stage, message: "boom" });
      expect(s).toMatchObject({ step: "error", stage, message: "boom", signerMayExist: false });
    },
  );

  it("FAIL while confirming reports that the agent signer may already exist on-chain", () => {
    const s = mintReducer(play(happyPath.slice(0, 7)), {
      type: "FAIL",
      stage: "confirming",
      message: "timeout",
    });
    expect(s).toMatchObject({ step: "error", signerMayExist: true, policyContractId: "CPOLICY" });
    // The error state never carries key material.
    expect(JSON.stringify(s)).not.toContain("SSECRET");
  });

  it("RESET recovers from error and from success", () => {
    const err = mintReducer(play(happyPath.slice(0, 2)), {
      type: "FAIL",
      stage: "policy-creation",
      message: "x",
    });
    expect(mintReducer(err, { type: "RESET" })).toEqual(initialMintState);
    expect(mintReducer(play(happyPath), { type: "RESET" })).toEqual(initialMintState);
  });

  it("isMintBusy is true only mid-flight", () => {
    expect(isMintBusy(initialMintState)).toBe(false);
    expect(isMintBusy(play(happyPath.slice(0, 3)))).toBe(true);
    expect(isMintBusy(play(happyPath))).toBe(false);
  });

  it("lands on awaiting-confirmation with a summary of the exact budget/token/expiry", () => {
    const s = play(happyPath.slice(0, 3));
    expect(s).toMatchObject({
      step: "awaiting-confirmation",
      policyContractId: "CPOLICY",
      summary: {
        tokenLabel: "XLM",
        tokenId: "CTOKEN",
        budgetLabel: "10 XLM",
        budgetBaseUnits: "100000000",
      },
    });
  });
});

describe("summarizeMintConfig (#563)", () => {
  it("shows a human-readable asset name, not just the contract id", () => {
    const summary = summarizeMintConfig({
      ...config,
      token: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      tokenSymbol: "USDC",
      tokenDecimals: 7,
      amountBaseUnits: "2500000",
    });
    // The label leads with the symbol; the id is secondary.
    expect(summary.tokenLabel).toBe("USDC");
    expect(summary.budgetLabel).toBe("0.25 USDC");
    expect(summary.tokenId).toBe("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75");
  });

  it("restates the expiry and window in human-readable form", () => {
    const summary = summarizeMintConfig(config);
    expect(summary.expiryLabel).toBe(new Date(1_800_000_000 * 1000).toLocaleString());
    expect(summary.windowLabel).toBe("per 1 day(s)");
    expect(summarizeMintConfig({ ...config, expiresAtSeconds: undefined }).expiryLabel).toMatch(
      /No expiry/,
    );
    expect(summarizeMintConfig({ ...config, windowSeconds: 3_600 }).windowLabel).toBe(
      "per 1 hour(s)",
    );
  });

  it("cannot drift from what the mint transaction encodes", () => {
    // The summary is derived from the SAME MintConfig fields that feed
    // generatePolicy's tokenBudget and addAgentKey's grant.
    const summary = summarizeMintConfig(config);
    expect(summary.budgetBaseUnits).toBe(config.amountBaseUnits);
    expect(summary.tokenId).toBe(config.token);
    expect(summary.tokenLabel).toBe(config.tokenSymbol);
  });
});

function effects(over: Partial<MintEffects> = {}) {
  const order: string[] = [];
  const e: MintEffects = {
    generateKey: vi.fn(async () => {
      order.push("generateKey");
      return key;
    }),
    generatePolicy: vi.fn(async () => {
      order.push("generatePolicy");
      return { id: "pol-1" } as never;
    }),
    simulateDeploy: vi.fn(async () => {
      order.push("simulate");
      return { ok: true };
    }),
    deployInstance: vi.fn(async () => {
      order.push("deploy");
      return { contractId: "CPOLICY" };
    }),
    confirmDetails: vi.fn(async () => {
      order.push("confirmDetails");
    }),
    attachPolicy: vi.fn(async () => {
      order.push("attach");
      return { hash: "attachtx" };
    }),
    recordDeployment: vi.fn(async () => {
      order.push("record");
    }),
    addAgentKey: vi.fn(async () => {
      order.push("addAgentKey");
      return { hash: "addtx" };
    }),
    confirm: vi.fn(async () => {
      order.push("confirm");
    }),
    ...over,
  };
  return { e, order };
}

describe("runMint", () => {
  it("runs deploy → confirm details → attach (passkey) → add signer (passkey) → confirm and ends in success", async () => {
    const { e, order } = effects();
    const events: MintEvent[] = [];
    await runMint(config, { effects: e, wallet: "CWALLET", dispatch: (ev) => events.push(ev) });
    expect(order).toEqual([
      "generateKey",
      "generatePolicy",
      "simulate",
      "deploy",
      "confirmDetails",
      "attach",
      "record",
      "addAgentKey",
      "confirm",
    ]);
    expect(e.addAgentKey).toHaveBeenCalledWith({
      publicKey: "GAGENT",
      token: "CTOKEN",
      policyContractId: "CPOLICY",
      expiresAtSeconds: 1_800_000_000,
    });
    const final = events.reduce(mintReducer, initialMintState);
    expect(final.step).toBe("success");
  });

  it("shows the exact budget/token/expiry summary before any passkey prompt", async () => {
    const { e, order } = effects();
    const events: MintEvent[] = [];
    await runMint(config, { effects: e, wallet: "CWALLET", dispatch: (ev) => events.push(ev) });

    // Confirmation runs BEFORE the first passkey call (attachPolicy).
    expect(order.indexOf("confirmDetails")).toBeLessThan(order.indexOf("attach"));
    expect(e.confirmDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenLabel: "XLM",
        tokenId: "CTOKEN",
        budgetBaseUnits: "100000000",
        budgetLabel: "10 XLM",
      }),
    );

    // The summary in the awaiting-confirmation state is the same copy.
    const atConfirm = events
      .slice(0, events.findIndex((ev) => ev.type === "DETAILS_CONFIRMED"))
      .reduce(mintReducer, initialMintState);
    expect(atConfirm).toMatchObject({
      step: "awaiting-confirmation",
      summary: summarizeMintConfig(config),
    });
  });

  it("the summary passed to confirmDetails matches what generatePolicy and addAgentKey encode", async () => {
    const { e } = effects();
    const events: MintEvent[] = [];
    await runMint(config, { effects: e, wallet: "CWALLET", dispatch: (ev) => events.push(ev) });

    const summary = (e.confirmDetails as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      budgetBaseUnits: string;
      tokenId: string;
      tokenLabel: string;
    };
    // generatePolicy receives the same config (its tokenBudget encodes these).
    expect(e.generatePolicy).toHaveBeenCalledWith(config, "CWALLET");
    // addAgentKey receives the same token and config-derived expiry.
    expect(e.addAgentKey).toHaveBeenCalledWith(
      expect.objectContaining({
        token: config.token,
        expiresAtSeconds: config.expiresAtSeconds,
      }),
    );
    // And the summary restates those exact values — no drift.
    expect(summary.budgetBaseUnits).toBe(config.amountBaseUnits);
    expect(summary.tokenId).toBe(config.token);
    expect(summary.tokenLabel).toBe(config.tokenSymbol);
  });

  it("stops before any passkey prompt when the deploy simulation fails", async () => {
    const { e } = effects({
      simulateDeploy: vi.fn(async () => ({ ok: false, error: "bad budget" })),
    });
    const events: MintEvent[] = [];
    await runMint(config, { effects: e, wallet: "CWALLET", dispatch: (ev) => events.push(ev) });
    expect(e.confirmDetails).not.toHaveBeenCalled();
    expect(e.attachPolicy).not.toHaveBeenCalled();
    expect(e.addAgentKey).not.toHaveBeenCalled();
    expect(events.reduce(mintReducer, initialMintState)).toMatchObject({
      step: "error",
      stage: "policy-creation",
      message: "bad budget",
    });
  });

  it("a refused confirmation fails before any passkey prompt and never adds the signer", async () => {
    const { e } = effects({
      confirmDetails: vi.fn(async () => {
        throw new Error("Mint cancelled: budget details were not confirmed.");
      }),
    });
    const events: MintEvent[] = [];
    await runMint(config, { effects: e, wallet: "CWALLET", dispatch: (ev) => events.push(ev) });
    expect(e.attachPolicy).not.toHaveBeenCalled();
    expect(e.addAgentKey).not.toHaveBeenCalled();
    expect(events.reduce(mintReducer, initialMintState)).toMatchObject({
      step: "error",
      stage: "awaiting-confirmation",
      message: "Mint cancelled: budget details were not confirmed.",
      signerMayExist: false,
    });
  });

  it("a refused passkey approval for the attach fails at attaching-policy and never adds the signer", async () => {
    const { e } = effects({
      attachPolicy: vi.fn(async () => {
        throw new Error("passkey cancelled");
      }),
    });
    const events: MintEvent[] = [];
    await runMint(config, { effects: e, wallet: "CWALLET", dispatch: (ev) => events.push(ev) });
    expect(e.addAgentKey).not.toHaveBeenCalled();
    expect(events.reduce(mintReducer, initialMintState)).toMatchObject({
      step: "error",
      stage: "attaching-policy",
      signerMayExist: false,
    });
  });

  it("a confirmation timeout reports the signer may exist so the operator can revoke", async () => {
    const { e } = effects({
      confirm: vi.fn(async () => {
        throw new Error("not final");
      }),
    });
    const events: MintEvent[] = [];
    await runMint(config, { effects: e, wallet: "CWALLET", dispatch: (ev) => events.push(ev) });
    expect(events.reduce(mintReducer, initialMintState)).toMatchObject({
      step: "error",
      stage: "confirming",
      signerMayExist: true,
    });
  });

  it("error copy goes through the redaction hook", async () => {
    const { e } = effects({
      deployInstance: vi.fn(async () => {
        throw new Error("leak SSECRET");
      }),
    });
    const events: MintEvent[] = [];
    await runMint(config, {
      effects: e,
      wallet: "CWALLET",
      dispatch: (ev) => events.push(ev),
      errorMessage: () => "redacted",
    });
    expect(events.reduce(mintReducer, initialMintState)).toMatchObject({ message: "redacted" });
  });
});
