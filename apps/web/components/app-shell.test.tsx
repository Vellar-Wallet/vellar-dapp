import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #785: the unknown ("loading") connection state must render a deliberate
// treatment instead of flashing the disconnected UI. Hoisted mutable state lets
// the mocked hooks switch states between cases (vi.mock factories are hoisted
// above ordinary module-scope declarations).
const shellState = vi.hoisted(() => ({
  status: "loading" as "loading" | "connected" | "disconnected",
  session: null as null | { accountId: string; network: string },
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: shellState.replace, push: vi.fn() }),
  usePathname: () => "/dashboard",
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/wallet-context", () => ({
  useWalletStatus: () => shellState.status,
  useWalletSession: () => shellState.session,
  useWalletActions: () => ({ disconnect: vi.fn() }),
}));

import { AppShell } from "./app-shell";

const CONNECTED_ACCOUNT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("app shell connection states (issue #785)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellState.status = "loading";
    shellState.session = null;
  });

  it("shows a deliberate loading treatment while connection state is unknown", () => {
    render(
      <AppShell>
        <div>page content</div>
      </AppShell>,
    );

    expect(screen.getByText("Restoring your session…")).toBeTruthy();
    expect(screen.queryByText("Redirecting…")).toBeNull();
    expect(screen.queryByText("Wallet")).toBeNull();
    expect(screen.queryByText("Disconnect")).toBeNull();
    expect(screen.queryByText("page content")).toBeNull();
    expect(shellState.replace).not.toHaveBeenCalled();
  });

  it("redirects a resolved disconnected session without flashing shell chrome", () => {
    shellState.status = "disconnected";

    render(
      <AppShell>
        <div>page content</div>
      </AppShell>,
    );

    expect(screen.getByText("Redirecting…")).toBeTruthy();
    expect(screen.queryByText("Wallet")).toBeNull();
    expect(screen.queryByText("Disconnect")).toBeNull();
    expect(shellState.replace).toHaveBeenCalledWith("/app");
  });

  it("renders the full shell once a session is connected", () => {
    shellState.status = "connected";
    shellState.session = { accountId: CONNECTED_ACCOUNT, network: "testnet" };

    render(
      <AppShell>
        <div>page content</div>
      </AppShell>,
    );

    expect(screen.getByText("Wallet")).toBeTruthy();
    expect(screen.getByText("Send / Swap")).toBeTruthy();
    expect(screen.getByText("testnet network")).toBeTruthy();
    expect(screen.getByText("Disconnect")).toBeTruthy();
    expect(screen.getByText("page content")).toBeTruthy();
    expect(shellState.replace).not.toHaveBeenCalled();
  });
});
