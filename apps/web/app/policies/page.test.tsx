import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletProvider } from "@/lib/wallet-context";
import Policies, { detectPolicyConflicts, rememberAttachedPolicy } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/policies",
}));

const { listMock, validateMock, generateMock, simulateMock, deployMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  validateMock: vi.fn(),
  generateMock: vi.fn(),
  simulateMock: vi.fn(),
  deployMock: vi.fn(),
}));
vi.mock("@/lib/policy", async () => {
  const actual = await vi.importActual<typeof import("@/lib/policy")>("@/lib/policy");
  return {
    ...actual,
    listTemplates: listMock,
    validatePolicy: validateMock,
    generatePolicy: generateMock,
    simulatePolicyDeploy: simulateMock,
    deployPolicy: deployMock,
  };
});

const { runtimeMock } = vi.hoisted(() => ({ runtimeMock: vi.fn() }));
vi.mock("@/lib/connector-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/connector-factory")>();
  return { ...actual, getWalletRuntime: runtimeMock };
});

// #335: the policy builder is gated behind a gradual-rollout feature flag,
// which defaults OFF for any session with no rollout configured. This suite
// tests the builder's own behavior (templates, validation, deploy), not the
// flag gate itself (see lib/feature-flags.test.ts and the "flag gating"
// describe block below for that) — force the flag on here so the existing
// assertions keep exercising the real UI rather than the "not yet available"
// fallback.
vi.mock("@/lib/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/feature-flags")>();
  return { ...actual, isFlagEnabled: () => true };
});

const SESSION = {
  accountId: "CWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDE",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T10:00:00.000Z",
  lastActiveAt: "2026-07-16T10:00:00.000Z",
};

const templates = [
  {
    type: "spending_limit",
    title: "Spending limit",
    description: "Cap XLM per window.",
    enforcement: { kind: "policy-contract", wasmHash: "ab".repeat(32) },
  },
  {
    type: "timelock",
    title: "Time-lock",
    description: "Delay admin actions.",
    enforcement: { kind: "custom-contract-pending" },
  },
];

function renderPage() {
  window.localStorage.setItem("vellar.session", JSON.stringify(SESSION));
  render(
    <WalletProvider>
      <Policies />
    </WalletProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  listMock.mockResolvedValue(templates);
});

describe("Policy builder", () => {
  it("lists templates and disables the coming-soon one", async () => {
    renderPage();
    expect(await screen.findByText("Spending limit")).toBeDefined();
    expect(screen.getByText("Time-lock")).toBeDefined();
    expect(screen.getByText("Coming soon")).toBeDefined();
  });

  const generatedSpending = {
    id: "p1",
    createdAt: "2026-07-17T00:00:00Z",
    status: "generated" as const,
    definition: {
      version: "1",
      type: "spending_limit",
      owners: [SESSION.accountId],
      spendingLimits: { dailyXlm: "100" },
    },
    policyHash: "f".repeat(64),
    manifest: {
      template: "spending_limit",
      enforcement: {
        kind: "policy-contract" as const,
        wasmHash: "ab".repeat(32),
        constructorArgs: { dailyLimitStroops: "1000000000", windowSeconds: 86400 },
      },
      network: "testnet" as const,
    },
  };

  it("configures a spending limit, validates, generates, and shows the review artifacts", async () => {
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    generateMock.mockResolvedValue(generatedSpending);

    renderPage();
    fireEvent.click(await screen.findByText("Spending limit"));
    fireEvent.change(await screen.findByLabelText(/daily limit/i), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /validate & generate/i }));

    expect(await screen.findByText(/policy generated/i)).toBeDefined();
    expect(screen.getByText("f".repeat(64))).toBeDefined();
    // The enforced cap is shown honestly (100 XLM / 24h cumulative).
    expect(screen.getByText(/100 XLM/)).toBeDefined();
    expect(validateMock).toHaveBeenCalledWith(expect.objectContaining({ type: "spending_limit" }));
  });

  it("deploys the generated policy: simulate → attach → success", async () => {
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    generateMock.mockResolvedValue(generatedSpending);
    simulateMock.mockResolvedValue({ ok: true, minResourceFee: "5000" });
    runtimeMock.mockResolvedValue({ resume: vi.fn(), attachPolicy: vi.fn() });
    deployMock.mockResolvedValue({
      policy: { ...generatedSpending, status: "deployed" },
      contractId: "CDEPLOYED234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567AB",
      attachTxHash: "attachhash123",
    });

    renderPage();
    fireEvent.click(await screen.findByText("Spending limit"));
    fireEvent.change(await screen.findByLabelText(/daily limit/i), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /validate & generate/i }));

    fireEvent.click(await screen.findByRole("button", { name: /deploy to my account/i }));

    expect(await screen.findByText(/policy attached to your account/i)).toBeDefined();
    expect(screen.getByText(/attachhash123/)).toBeDefined();
    await waitFor(() => expect(simulateMock).toHaveBeenCalledWith("p1", SESSION.accountId));
    expect(deployMock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ accountId: SESSION.accountId }),
      expect.anything(),
    );
  });

  it("aborts deploy when simulation fails — never prompts the passkey", async () => {
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    generateMock.mockResolvedValue(generatedSpending);
    simulateMock.mockResolvedValue({ ok: false, error: "insufficient sponsor balance" });

    renderPage();
    fireEvent.click(await screen.findByText("Spending limit"));
    fireEvent.change(await screen.findByLabelText(/daily limit/i), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /validate & generate/i }));
    fireEvent.click(await screen.findByRole("button", { name: /deploy to my account/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/insufficient sponsor/i);
    expect(deployMock).not.toHaveBeenCalled();
  });

  it("surfaces validation errors without generating", async () => {
    validateMock.mockResolvedValue({
      valid: false,
      errors: ["spendingLimits: set dailyXlm and/or perTxXlm"],
    });

    renderPage();
    fireEvent.click(await screen.findByText("Spending limit"));
    fireEvent.click(screen.getByRole("button", { name: /validate & generate/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/set dailyXlm/i);
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe("Policy builder — on-chain safety rules (#399) and provenance modes (#398)", () => {
  const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  it("sends token-denominated safety rules with the spending-limit definition", async () => {
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    generateMock.mockResolvedValue({
      id: "p2",
      createdAt: "2026-09-25T00:00:00Z",
      status: "generated",
      definition: { version: "1", type: "spending_limit", owners: [SESSION.accountId] },
      policyHash: "e".repeat(64),
      manifest: {
        template: "spending_limit",
        enforcement: {
          kind: "policy-contract",
          wasmHash: "ab".repeat(32),
          constructorArgs: {
            dailyLimitStroops: "1000000000",
            windowSeconds: 86400,
            rules: {
              maxSingleTransfer: [{ token: XLM_SAC, amountBaseUnits: "200000000" }],
              allowedTokens: [XLM_SAC],
            },
          },
        },
        network: "testnet",
      },
    });

    renderPage();
    fireEvent.click(await screen.findByText("Spending limit"));
    expect(screen.getByTestId("safety-rules").textContent).toMatch(/supported transfer patterns/i);
    expect(screen.getByTestId("safety-rules").textContent).toMatch(/never in USD/i);
    fireEvent.change(screen.getByLabelText(/daily limit/i), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText(/max single transfer — token contract/i), {
      target: { value: XLM_SAC },
    });
    fireEvent.change(screen.getByLabelText(/max single transfer — amount/i), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText(/allowed token contracts/i), {
      target: { value: XLM_SAC },
    });
    fireEvent.click(screen.getByRole("button", { name: /validate & generate/i }));

    await waitFor(() =>
      expect(validateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "spending_limit",
          safetyRules: {
            maxSingleTransfer: [{ token: XLM_SAC, amountBaseUnits: "200000000" }],
            allowedTokens: [XLM_SAC],
          },
        }),
      ),
    );
    // The review step states the enforced rules, scoped to the known pattern.
    const review = await screen.findByTestId("review-safety-rules");
    expect(review.textContent).toMatch(/No single transfer .* above 20 units/);
    expect(review.textContent).toMatch(/not a universal firewall/i);
  });

  it("verified_only exposes strict / trusted-publishers modes and says provenance, not safety", async () => {
    listMock.mockResolvedValue([
      {
        type: "verified_only",
        title: "Verified provenance only",
        description: "Restrict a signer to contracts with verified source provenance.",
        enforcement: { kind: "policy-contract", wasmHash: "cd".repeat(32) },
      },
    ]);
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    generateMock.mockResolvedValue({
      id: "p3",
      createdAt: "2026-09-25T00:00:00Z",
      status: "generated",
      definition: {
        version: "1",
        type: "verified_only",
        owners: [SESSION.accountId],
        provenance: { mode: "trusted_publishers", trustedPublishers: ["github.com/vellar-wallet"] },
      },
      policyHash: "d".repeat(64),
      manifest: {
        template: "verified_only",
        enforcement: {
          kind: "policy-contract",
          wasmHash: "cd".repeat(32),
          constructorArgs: {
            registry: "CREG",
            mode: "trusted_publishers",
            trustedPublisherIds: ["ab".repeat(32)],
          },
        },
        network: "testnet",
      },
    });

    renderPage();
    fireEvent.click(await screen.findByText("Verified provenance only"));
    const mode = screen.getByTestId("provenance-mode");
    expect(mode.textContent).toMatch(/not\s+that it is audited, benign or safe/i);
    fireEvent.change(screen.getByLabelText(/^mode$/i), { target: { value: "trusted_publishers" } });
    fireEvent.change(screen.getByLabelText(/trusted publishers/i), {
      target: { value: "github.com/vellar-wallet" },
    });
    fireEvent.click(screen.getByRole("button", { name: /validate & generate/i }));
    await waitFor(() =>
      expect(validateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "verified_only",
          provenance: {
            mode: "trusted_publishers",
            trustedPublishers: ["github.com/vellar-wallet"],
          },
        }),
      ),
    );
    expect((await screen.findByText(/restricted to 1 trusted publisher/i)).textContent).toMatch(
      /not audited, benign or\s+safe/i,
    );
  });
});

describe("Policy builder — conflict warning for overlapping attached policies (#570)", () => {
  const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const USDC_SAC = "CBIELTK6YBZJU5UP2QPQEHGTTDAKAEVWTODQO6QD3J6XEUOFQMS5TRHT";

  const attachedSpendingPolicy = {
    contractId: "CATTACHED111111111111111111111111111111111111111111111111",
    definition: {
      version: "1",
      type: "spending_limit",
      owners: [SESSION.accountId],
      spendingLimits: { dailyXlm: "100" },
    },
  };

  const secondSpendingPolicy = {
    id: "p-overlap",
    createdAt: "2026-10-18T00:00:00Z",
    status: "generated" as const,
    definition: {
      version: "1",
      type: "spending_limit",
      owners: [SESSION.accountId],
      spendingLimits: { dailyXlm: "50" },
    },
    policyHash: "a".repeat(64),
    manifest: {
      template: "spending_limit",
      enforcement: {
        kind: "policy-contract" as const,
        wasmHash: "ab".repeat(32),
        constructorArgs: { dailyLimitStroops: "500000000", windowSeconds: 86400 },
      },
      network: "testnet" as const,
    },
  };

  const nonOverlappingVerifiedPolicy = {
    id: "p-no-overlap",
    createdAt: "2026-10-18T00:00:00Z",
    status: "generated" as const,
    definition: {
      version: "1",
      type: "verified_only",
      owners: [SESSION.accountId],
      provenance: { mode: "strict" as const },
    },
    policyHash: "b".repeat(64),
    manifest: {
      template: "verified_only",
      enforcement: {
        kind: "policy-contract" as const,
        wasmHash: "cd".repeat(32),
        constructorArgs: {
          registry: "CREG",
          mode: "strict" as const,
          trustedPublisherIds: [],
        },
      },
      network: "testnet" as const,
    },
  };

  it("surfaces a clear warning before passkey approval when a new policy overlaps with an attached one, without blocking deploy", async () => {
    rememberAttachedPolicy(SESSION.accountId, attachedSpendingPolicy);
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    generateMock.mockResolvedValue(secondSpendingPolicy);
    simulateMock.mockResolvedValue({ ok: true, minResourceFee: "5000" });
    const attachPolicy = vi.fn().mockResolvedValue({ hash: "attachhash-second" });
    runtimeMock.mockResolvedValue({ resume: vi.fn(), attachPolicy });
    deployMock.mockImplementation(async (_id, _session, rt) => {
      const { hash } = await rt.attachPolicy("CDEPLOYEDSECOND234567890ABCDEFGHIJKLMNOPQRSTUVW");
      return {
        policy: { ...secondSpendingPolicy, status: "deployed" },
        contractId: "CDEPLOYEDSECOND234567890ABCDEFGHIJKLMNOPQRSTUVW",
        attachTxHash: hash,
      };
    });

    renderPage();
    fireEvent.click(await screen.findByText("Spending limit"));
    fireEvent.change(await screen.findByLabelText(/daily limit/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /validate & generate/i }));

    // Warning appears on the review card BEFORE any passkey approval is triggered.
    const warning = await screen.findByTestId("policy-conflict-warning");
    expect(warning.textContent).toMatch(/overlaps in scope/i);
    expect(warning.textContent).toMatch(/XLM spending limit/i);
    expect(warning.textContent).toContain(attachedSpendingPolicy.contractId);
    expect(warning.textContent).toMatch(/can still proceed/i);
    expect(attachPolicy).not.toHaveBeenCalled();

    // The user is not blocked from proceeding if they understand the overlap.
    const deployBtn = screen.getByRole("button", { name: /deploy to my account/i });
    expect((deployBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(deployBtn);

    expect(await screen.findByText(/policy attached to your account/i)).toBeDefined();
    expect(attachPolicy).toHaveBeenCalledWith("CDEPLOYEDSECOND234567890ABCDEFGHIJKLMNOPQRSTUVW");
  });

  it("shows no warning when the new policy does not overlap in scope with the attached policy", async () => {
    rememberAttachedPolicy(SESSION.accountId, attachedSpendingPolicy);
    listMock.mockResolvedValue([
      ...templates,
      {
        type: "verified_only",
        title: "Verified provenance only",
        description: "Restrict a signer to contracts with verified source provenance.",
        enforcement: { kind: "policy-contract", wasmHash: "cd".repeat(32) },
      },
    ]);
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    generateMock.mockResolvedValue(nonOverlappingVerifiedPolicy);

    renderPage();
    fireEvent.click(await screen.findByText("Verified provenance only"));
    fireEvent.click(screen.getByRole("button", { name: /validate & generate/i }));

    expect(await screen.findByText(/policy generated/i)).toBeDefined();
    expect(screen.queryByTestId("policy-conflict-warning")).toBeNull();
  });

  it("detectPolicyConflicts distinguishes overlapping vs disjoint token scopes", () => {
    const tokenAPolicy = {
      version: "1",
      type: "token_spending_limit",
      owners: [SESSION.accountId],
      tokenBudget: { token: XLM_SAC, amountBaseUnits: "10000000" },
    };
    const tokenBPolicy = {
      version: "1",
      type: "token_spending_limit",
      owners: [SESSION.accountId],
      tokenBudget: { token: USDC_SAC, amountBaseUnits: "50000000" },
    };
    expect(detectPolicyConflicts(tokenBPolicy, [tokenAPolicy])).toEqual([]);
    const conflicts = detectPolicyConflicts(tokenAPolicy, [
      { contractId: "CEXISTING", definition: tokenAPolicy },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.overlappingScopes).toContain(`spending:token:${XLM_SAC}`);
  });
});
