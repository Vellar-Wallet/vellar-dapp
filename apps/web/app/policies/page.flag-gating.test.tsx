import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletProvider } from "@/lib/wallet-context";
import Policies from "./page";

// Issue #335 acceptance criterion: "a test verifying flagged and unflagged
// users see the correct UI". Deliberately a separate file from
// page.test.tsx, which mocks the flag on (always true) so its own
// assertions exercise the real builder — this file leaves the flag's real
// evaluation in place and drives it via env vars instead, the way it's
// actually configured in production.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/policies",
}));

vi.mock("@/lib/policy", async () => {
  const actual = await vi.importActual<typeof import("@/lib/policy")>("@/lib/policy");
  return { ...actual, listTemplates: vi.fn().mockResolvedValue([]) };
});

const SESSION = {
  accountId: "CWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDE",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T10:00:00.000Z",
  lastActiveAt: "2026-07-16T10:00:00.000Z",
};

function renderPage() {
  window.localStorage.setItem("vellar.session", JSON.stringify(SESSION));
  render(
    <WalletProvider>
      <Policies />
    </WalletProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  delete process.env.NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ROLLOUT_PERCENT;
  delete process.env.NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ALLOWLIST;
});

describe("Policy builder — feature flag gating (#335)", () => {
  it("shows the not-yet-available fallback for an unflagged connected session (default: 0% rollout)", async () => {
    renderPage();
    expect(await screen.findByText(/rolling out gradually/i)).toBeDefined();
    // The real builder's template picker must NOT render (note: the
    // fallback copy itself mentions "spending limits" in prose, so assert
    // against the picker's own loading state instead of a text match that
    // would also match the fallback's wording).
    expect(screen.queryByText(/loading templates/i)).toBeNull();
  });

  it("does not show the flag-gated builder content when no wallet is connected (AppShell's own auth redirect takes over first)", async () => {
    render(
      <WalletProvider>
        <Policies />
      </WalletProvider>,
    );
    // AppShell redirects an unauthenticated visitor before any policy-builder
    // content (flagged or not) would render — see components/app-shell.tsx.
    // This asserts policyBuilderVisibleFor's null-accountId branch doesn't
    // somehow leak the real builder through in that state, not that a
    // specific fallback message appears (AppShell owns that UI).
    expect(await screen.findByText(/redirecting/i)).toBeDefined();
    expect(screen.queryByText("Account policies")).toBeNull();
  });

  it("shows the real builder for an allowlisted account, even at 0% rollout", async () => {
    process.env.NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ALLOWLIST = SESSION.accountId;
    // Re-import BOTH the page and WalletProvider from a fresh module
    // registry so the page's module-level readFlagConfig() call (which
    // picks up the env var set just above — it's read once at module load,
    // matching how a real Next.js build inlines NEXT_PUBLIC_* at build
    // time) and WalletProvider's React context are the same module
    // instances; mixing a freshly-imported page with the already-imported
    // WalletProvider from the top of this file throws "must be used inside
    // <WalletProvider>" because they'd hold two distinct Context objects.
    vi.resetModules();
    const { default: FlaggedPolicies } = await import("./page");
    const { WalletProvider: FreshWalletProvider } = await import("@/lib/wallet-context");

    window.localStorage.setItem("vellar.session", JSON.stringify(SESSION));
    render(
      <FreshWalletProvider>
        <FlaggedPolicies />
      </FreshWalletProvider>,
    );

    expect(await screen.findByText("Account policies")).toBeDefined();
    expect(screen.queryByText(/rolling out gradually/i)).toBeNull();
  });
});
