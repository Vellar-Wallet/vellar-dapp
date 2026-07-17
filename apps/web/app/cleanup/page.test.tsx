import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Cleanup from "./page";
import { WalletProvider } from "@/lib/wallet-context";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/cleanup",
}));

const { planMock, executeMock, mergeMock, watchMock } = vi.hoisted(() => ({
  planMock: vi.fn(),
  executeMock: vi.fn(),
  mergeMock: vi.fn(),
  watchMock: vi.fn(),
}));
vi.mock("@/lib/lifecycle", () => ({
  planCleanup: planMock,
  executeCleanup: executeMock,
  buildMerge: mergeMock,
  watchTransaction: watchMock,
  labSignUrl: (xdr: string) => `https://lab.example/?xdr=${xdr}`,
}));

const SESSION = {
  accountId: "CWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDE",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T10:00:00.000Z",
  lastActiveAt: "2026-07-16T10:00:00.000Z",
};

const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";
const G2 = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

const blockedPlan = {
  accountId: G1,
  destination: G2,
  blockers: [
    { type: "data", description: 'Managed data entry "config"', actionRequired: "Delete it" },
  ],
  estimatedTransactions: 2,
  mergeReady: false,
};

const cleanupStep = {
  title: "Clean up the account",
  description: "One transaction that will: delete data",
  xdr: "CLEANUP_XDR",
  hash: "a".repeat(64),
};

const mergeStep = {
  title: "Merge and close the account",
  description: "Closes the account. This cannot be undone.",
  xdr: "MERGE_XDR",
  hash: "b".repeat(64),
};

async function inspectWith(plan: typeof blockedPlan) {
  planMock.mockResolvedValue({ plan });
  window.localStorage.setItem("vela.session", JSON.stringify(SESSION));
  render(
    <WalletProvider>
      <Cleanup />
    </WalletProvider>,
  );
  // AppShell restores the session asynchronously; wait for the form.
  fireEvent.change(await screen.findByLabelText(/old account/i), { target: { value: G1 } });
  fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: G2 } });
  fireEvent.click(screen.getByRole("button", { name: /inspect account/i }));
  await screen.findByText(/cleanup plan/i);
}

beforeEach(() => {
  vi.clearAllMocks();
  watchMock.mockReturnValue(new Promise(() => {})); // watching forever by default
});

describe("Cleanup wizard", () => {
  it("shows the plan's blockers with required actions", async () => {
    await inspectWith(blockedPlan);
    expect(screen.getByText(/managed data entry/i)).toBeDefined();
    expect(screen.getByText(/estimated transactions: 2/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /start cleanup/i })).toBeDefined();
  });

  it("cleanup step exposes the unsigned XDR, copy, Lab link, and watches", async () => {
    executeMock.mockResolvedValue({ steps: [cleanupStep], plan: blockedPlan });
    await inspectWith(blockedPlan);
    fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));

    expect(await screen.findByDisplayValue("CLEANUP_XDR")).toBeDefined();
    expect(screen.getByRole("link", { name: /stellar laboratory/i })).toBeDefined();
    expect(screen.getByText(/advances automatically/i)).toBeDefined();
    expect(watchMock).toHaveBeenCalledWith(cleanupStep.hash, expect.anything());
  });

  it("auto-advances cleanup → merge → done as hashes land", async () => {
    executeMock.mockResolvedValue({ steps: [cleanupStep], plan: blockedPlan });
    mergeMock.mockResolvedValue({ step: mergeStep });
    watchMock.mockResolvedValue(true); // every watched tx confirms immediately

    await inspectWith(blockedPlan);
    fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));

    await waitFor(() => expect(mergeMock).toHaveBeenCalledWith(G1, G2));
    expect(await screen.findByText(/account closed/i)).toBeDefined();
  });

  it("merge-ready plans skip straight to the merge step with the warning", async () => {
    mergeMock.mockResolvedValue({ step: mergeStep });
    await inspectWith({ ...blockedPlan, blockers: [], estimatedTransactions: 1, mergeReady: true });
    fireEvent.click(screen.getByRole("button", { name: /proceed to merge/i }));

    expect(await screen.findByDisplayValue("MERGE_XDR")).toBeDefined();
    expect(screen.getByText(/permanently/i)).toBeDefined();
  });

  it("offers keep-waiting when the network hasn't seen the tx in time", async () => {
    executeMock.mockResolvedValue({ steps: [cleanupStep], plan: blockedPlan });
    watchMock.mockResolvedValueOnce(false); // times out
    await inspectWith(blockedPlan);
    fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));

    expect(await screen.findByText(/not seen on the network yet/i)).toBeDefined();
    watchMock.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: /keep waiting/i }));
    expect(await screen.findByText(/advances automatically/i)).toBeDefined();
  });

  it("surfaces API errors", async () => {
    planMock.mockRejectedValue(new Error("account_not_found"));
    window.localStorage.setItem("vela.session", JSON.stringify(SESSION));
    render(
      <WalletProvider>
        <Cleanup />
      </WalletProvider>,
    );
    fireEvent.change(await screen.findByLabelText(/old account/i), { target: { value: G1 } });
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: G2 } });
    fireEvent.click(screen.getByRole("button", { name: /inspect account/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/account_not_found/);
  });
});
