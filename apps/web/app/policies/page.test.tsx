import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletProvider } from "@/lib/wallet-context";
import Policies from "./page";

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
  window.localStorage.setItem("vela.session", JSON.stringify(SESSION));
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
    expect(deployMock).toHaveBeenCalledWith("p1", expect.objectContaining({ accountId: SESSION.accountId }), expect.anything());
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
