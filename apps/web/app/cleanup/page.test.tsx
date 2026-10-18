import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CleanupPlan } from "@vellar/types";
import Cleanup, { ITEMIZED_SCROLL_THRESHOLD, itemizeCleanupPlan } from "./page";
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

const blockedPlan: CleanupPlan = {
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

async function inspectWith(plan: CleanupPlan, { strict = false } = {}) {
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

  it("renders an itemized list of every asset and trustline from the executing plan on the confirmation screen (#568)", async () => {
    const initialPlan: CleanupPlan = {
      accountId: G1,
      destination: G2,
      blockers: [
        {
          type: "trustline",
          description: "Trustline to USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          actionRequired: "Remove the USDC trustline (requires zero balance)",
        },
      ],
      estimatedTransactions: 2,
      mergeReady: false,
    };
    const executingPlan: CleanupPlan = {
      accountId: G1,
      destination: G2,
      blockers: [
        {
          type: "balance",
          description: "Holds 42.5000000 USDC",
          actionRequired: "Transfer or burn the USDC balance before removing its trustline",
        },
        {
          type: "trustline",
          description: "Trustline to USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          actionRequired: "Remove the USDC trustline (requires zero balance)",
        },
        {
          type: "trustline",
          description: "Trustline to EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
          actionRequired: "Remove the EURC trustline (requires zero balance)",
        },
      ],
      estimatedTransactions: 2,
      mergeReady: false,
    };

    executeMock.mockResolvedValue({ steps: [cleanupStep], plan: executingPlan });
    await inspectWith(initialPlan);
    fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));

    await screen.findByDisplayValue("CLEANUP_XDR");
    const confirmation = screen.getByTestId("cleanup-itemized-confirmation");
    const rows = within(confirmation).getAllByTestId("cleanup-itemized-row");
    // 3 blockers from `executingPlan` (not the 1 blocker from `initialPlan`) + 1 native XLM merge row = 4 rows
    expect(rows).toHaveLength(4);
    expect(confirmation.textContent).toContain("Holds 42.5000000 USDC");
    expect(confirmation.textContent).toContain(
      "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    );
    expect(confirmation.textContent).toContain(
      "EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
    );
    expect(confirmation.textContent).toContain("XLM (native)");
  });

  it("renders a scrollable itemized list when a plan affects many trustlines (#568)", async () => {
    const manyTrustlines = Array.from({ length: 12 }, (_, idx) => {
      const code = `TOK${idx + 1}`;
      return {
        type: "trustline" as const,
        description: `Trustline to ${code}:GISSUER${String(idx + 1).padStart(48, "A")}`,
        actionRequired: `Remove the ${code} trustline (requires zero balance)`,
      };
    });
    const largePlan: CleanupPlan = {
      accountId: G1,
      destination: G2,
      blockers: manyTrustlines,
      estimatedTransactions: 2,
      mergeReady: false,
    };

    expect(itemizeCleanupPlan(largePlan).length).toBeGreaterThan(ITEMIZED_SCROLL_THRESHOLD);
    executeMock.mockResolvedValue({ steps: [cleanupStep], plan: largePlan });
    await inspectWith(largePlan);

    const planList = screen.getByTestId("plan-blockers-list");
    expect(planList.getAttribute("data-scrollable")).toBe("true");
    expect(planList.className).toContain("overflow-y-auto");

    fireEvent.click(screen.getByRole("button", { name: /start cleanup/i }));
    await screen.findByDisplayValue("CLEANUP_XDR");

    const itemizedList = screen.getByTestId("cleanup-itemized-list");
    expect(itemizedList.getAttribute("data-scrollable")).toBe("true");
    expect(itemizedList.className).toContain("overflow-y-auto");
    expect(itemizedList.className).toContain("max-h-60");
    const rows = within(itemizedList).getAllByTestId("cleanup-itemized-row");
    expect(rows).toHaveLength(13); // 12 trustlines + 1 native XLM merge
    expect(itemizedList.textContent).toContain("TOK1:");
    expect(itemizedList.textContent).toContain("TOK12:");
  });
});
