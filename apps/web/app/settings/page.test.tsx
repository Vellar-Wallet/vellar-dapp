import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import { WalletProvider } from "@/lib/wallet-context";
import Settings from "./page";

const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/settings",
}));

const { useSessionsMock, mutateAsync } = vi.hoisted(() => ({
  useSessionsMock: vi.fn(),
  mutateAsync: vi.fn(),
}));
vi.mock("@/lib/sessions", () => ({
  useSessions: useSessionsMock,
  useRevokeSession: () => ({ mutateAsync, isPending: false }),
}));

const { listAgentKeysMock, revokeAgentKeyMock, resumeMock } = vi.hoisted(() => ({
  listAgentKeysMock: vi.fn(),
  revokeAgentKeyMock: vi.fn(),
  resumeMock: vi.fn(),
}));
vi.mock("@/lib/connector-factory", () => ({
  createRealConnector: vi.fn(),
  getRealPaymentClient: vi.fn(),
  getWalletRuntime: async () => ({
    listAgentKeys: listAgentKeysMock,
    revokeAgentKey: revokeAgentKeyMock,
    resume: resumeMock,
  }),
}));

const walletSession: WalletSession = {
  accountId: "CACCOUNT",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  keyId: "passkey-id",
  createdAt: "2026-07-16T09:00:00.000Z",
  lastActiveAt: "2026-07-16T09:00:00.000Z",
  serverSessionId: "sess-current",
};

const records = [
  {
    id: "sess-current",
    contractId: "CACCOUNT",
    network: "testnet",
    createdAt: "2026-07-16T09:00:00.000Z",
    lastActiveAt: "2026-07-16T12:00:00.000Z",
  },
  {
    id: "sess-other",
    contractId: "CACCOUNT",
    network: "testnet",
    createdAt: "2026-07-15T09:00:00.000Z",
    lastActiveAt: "2026-07-15T10:00:00.000Z",
  },
];

function renderSettings() {
  return render(
    <WalletProvider>
      <Settings />
    </WalletProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.localStorage.setItem("vellar.session", JSON.stringify(walletSession));
  useSessionsMock.mockReturnValue({
    data: records,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
  mutateAsync.mockResolvedValue(undefined);
  resumeMock.mockResolvedValue(undefined);
  listAgentKeysMock.mockResolvedValue([]);
  revokeAgentKeyMock.mockResolvedValue({ alreadyRevoked: false, hashes: ["hash"] });
});

describe("Settings", () => {
  it("lists sessions and marks this device", async () => {
    renderSettings();

    expect(await screen.findByText("This device")).toBeDefined();
    expect(screen.getAllByText(/session started/i)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Revoke & sign out" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeDefined();
  });

  it("revokes another device without signing out", async () => {
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith("sess-other"));
    // Still connected: no redirect, session still persisted.
    expect(replace).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("vellar.session")).toContain("CACCOUNT");
  });

  it("revoking this device signs out and redirects", async () => {
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke & sign out" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith("sess-current"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app"));
    expect(window.localStorage.getItem("vellar.session")).toBeNull();
  });

  it("shows the error state with retry", async () => {
    const refetch = vi.fn();
    useSessionsMock.mockReturnValue({ data: undefined, isPending: false, isError: true, refetch });
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("lists and revokes an agent key on-chain with passkey confirmation", async () => {
    listAgentKeysMock.mockResolvedValue([
      {
        publicKey: "GAGENT",
        label: "Agent key GAGENT…GAGENT",
        status: "active",
        storage: "temporary",
        expiration: 2_000_000_000,
        boundContracts: ["CTOKEN"],
        policyContractIds: ["CPOLICY"],
      },
    ]);
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke on-chain" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm with passkey" }));

    await waitFor(() => expect(revokeAgentKeyMock).toHaveBeenCalledWith("GAGENT", ["CPOLICY"]));
    expect(resumeMock).toHaveBeenCalledWith(walletSession.keyId);
  });

  it("redirects to onboarding when disconnected", async () => {
    window.localStorage.clear();
    renderSettings();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app"));
  });
});
