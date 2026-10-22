import { StrictMode } from "react";
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

async function inspectWith(plan: typeof blockedPlan, { strict = false } = {}) {
  planMock.mockResolvedValue({ plan });
  window.localStorage.setItem("vellar.session", JSON.stringify(SESSION));
  const tree = (
    <WalletProvider>
      <Cleanup />
    </WalletProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  // AppShell restores the session asynchronously; wait for the form.
  fireEvent.change(await screen.findByLabelText(/old account/i), { target: { value: G1 } });
  fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: G2 } });
  fireEvent.click(screen.getByRole("button", { name: /inspect account/i }));
  await screen.findByText(/cleanup plan/i);
}

/** Click through the itemized confirmation that now sits before any signature. */
async function approveConfirm() {
  fireEvent.click(await screen.findByRole("button", { name: /looks right/i }));
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
    await screen.findByText(/confirm before signing/i);
    await approveConfirm();

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
    await approveConfirm();

    await waitFor(() => expect(mergeMock).toHaveBeenCalledWith(G1, G2));
    expect(await screen.findByText(/account closed/i)).toBeDefined();
  });

  // Regression: the unmount cleanup latches cancelledRef, and StrictMode mounts
  // → unmounts → remounts. If the remount doesn't un-latch it, every watch()
  // sees cancelled=true, returns before advancing, and the wizard stalls on the
  // step card forever. Unlike the other cases this mock HONOURS the cancelled
  // callback, exactly as the real watchTransaction does — that is what makes the
  // latch observable here.
  it("auto-advances to done after a StrictMode remount", async () => {
    executeMock.mockResolvedValue({ steps: [cleanupStep], plan: blockedPlan });
    mergeMock.mockResolvedValue({ step: mergeStep });
    watchMock.mockImplementation(
      async (_hash: string, options: { cancelled?: () => boolean }) => !options.cancelled?.(), // cancelled → never seen, mirroring the real watcher
    );

    await inspectWith(blockedPlan, { strict: true });
    fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));
    await approveConfirm();

    await waitFor(() => expect(mergeMock).toHaveBeenCalledWith(G1, G2));
    expect(await screen.findByText(/account closed/i)).toBeDefined();
  });

  it("merge-ready plans skip straight to the merge step with the warning", async () => {
    mergeMock.mockResolvedValue({ step: mergeStep });
    await inspectWith({ ...blockedPlan, blockers: [], estimatedTransactions: 1, mergeReady: true });
    fireEvent.click(screen.getByRole("button", { name: /proceed to merge/i }));
    await approveConfirm();

    expect(await screen.findByDisplayValue("MERGE_XDR")).toBeDefined();
    expect(screen.getByText(/permanently/i)).toBeDefined();
  });

  it("offers keep-waiting when the network hasn't seen the tx in time", async () => {
    executeMock.mockResolvedValue({ steps: [cleanupStep], plan: blockedPlan });
    watchMock.mockResolvedValueOnce(false); // times out
    await inspectWith(blockedPlan);
    fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));
    await approveConfirm();

    expect(await screen.findByText(/not seen on the network yet/i)).toBeDefined();
    watchMock.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: /keep waiting/i }));
    expect(await screen.findByText(/advances automatically/i)).toBeDefined();
  });

  it("surfaces API errors", async () => {
    planMock.mockRejectedValue(new Error("account_not_found"));
    window.localStorage.setItem("vellar.session", JSON.stringify(SESSION));
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

  describe("confirmation itemizes the executing plan", () => {
    const trustlines = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        type: "trustline",
        description: `Trustline to ASSET${i}:GISSUER${i}`,
        actionRequired: `Remove the ASSET${i} trustline (requires zero balance)`,
      }));

    it("lists every asset and trustline from the plan that will actually execute", async () => {
      // The inspected plan and the executing plan differ on purpose: the
      // confirmation must itemize the EXECUTING one.
      const executingPlan = {
        ...blockedPlan,
        blockers: [
          ...trustlines(2),
          {
            type: "balance",
            description: "Holds 100 USDC",
            actionRequired: "Transfer or burn the USDC balance before removing its trustline",
          },
        ],
      };
      executeMock.mockResolvedValue({ steps: [cleanupStep], plan: executingPlan });
      await inspectWith(blockedPlan);
      fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));

      const list = await screen.findByTestId("plan-item-list");
      expect(list.textContent).toContain("Trustline to ASSET0:GISSUER0");
      expect(list.textContent).toContain("Trustline to ASSET1:GISSUER1");
      expect(list.textContent).toContain("Holds 100 USDC");
    });

    it("scrolls a long trustline list without cutting any item off", async () => {
      const executingPlan = { ...blockedPlan, blockers: trustlines(20) };
      executeMock.mockResolvedValue({ steps: [cleanupStep], plan: executingPlan });
      await inspectWith(blockedPlan);
      fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));

      const list = await screen.findByTestId("plan-item-list");
      // Scrollable container: bounded height with overflow.
      expect(list.className).toMatch(/max-h-/);
      expect(list.className).toMatch(/overflow-y-auto/);
      // Every item is in the DOM — the scroll region never drops content.
      const rows = list.querySelectorAll("li");
      expect(rows).toHaveLength(20);
      for (let i = 0; i < 20; i++) {
        expect(list.textContent).toContain(`Trustline to ASSET${i}:GISSUER${i}`);
      }
    });

    it("says so plainly when the plan affects no assets or trustlines", async () => {
      executeMock.mockResolvedValue({
        steps: [cleanupStep],
        plan: { ...blockedPlan, blockers: [] },
      });
      await inspectWith(blockedPlan);
      fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));

      expect(await screen.findByText(/no assets or trustlines are affected/i)).toBeDefined();
      expect(screen.queryByTestId("plan-item-list")).toBeNull();
    });

    it("does not open any signing step until the confirmation is approved", async () => {
      executeMock.mockResolvedValue({ steps: [cleanupStep], plan: blockedPlan });
      await inspectWith(blockedPlan);
      fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));

      await screen.findByText(/confirm before signing/i);
      expect(screen.queryByDisplayValue("CLEANUP_XDR")).toBeNull();
      expect(watchMock).not.toHaveBeenCalled();

      await approveConfirm();
      expect(await screen.findByDisplayValue("CLEANUP_XDR")).toBeDefined();
    });
  });
});
