// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import {
  WALLET_WASM_CHANGELOG,
  WalletUpgradeCard,
  getWalletWasmChangelog,
} from "./wallet-upgrade-card";

const { useWalletVersionMock, useUpgradeWalletMock } = vi.hoisted(() => ({
  useWalletVersionMock: vi.fn(),
  useUpgradeWalletMock: vi.fn(),
}));

vi.mock("@/lib/wallet-version", () => ({
  useWalletVersion: useWalletVersionMock,
  useUpgradeWallet: useUpgradeWalletMock,
}));

const PINNED_HASH = "fdefad64b96837147e1c333e51f537b696eab925e9f147e63d597c04e3c903f0";
const OLD_HASH = "1111111111111111111111111111111111111111111111111111111111111111";
const UNKNOWN_HASH = "2222222222222222222222222222222222222222222222222222222222222222";

const session: WalletSession = {
  accountId: "CWALLET572",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T09:00:00.000Z",
  lastActiveAt: "2026-07-16T09:00:00.000Z",
  keyId: "cred-572",
};

describe("WalletUpgradeCard changelog (#572)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUpgradeWalletMock.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("looks up changelog entries by normalized wasm hash", () => {
    const entry = getWalletWasmChangelog(`0x${PINNED_HASH.toUpperCase()}`);
    expect(entry).toEqual(WALLET_WASM_CHANGELOG[PINNED_HASH]);
    expect(getWalletWasmChangelog(UNKNOWN_HASH)).toBeNull();
  });

  it("renders the changelog version summary and link when an entry exists for the target wasm hash", () => {
    useWalletVersionMock.mockReturnValue({
      data: {
        state: "upgrade-available",
        currentHash: OLD_HASH,
        targetHash: PINNED_HASH,
      },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<WalletUpgradeCard session={session} />);

    const changelogBox = screen.getByTestId("wallet-upgrade-changelog");
    expect(changelogBox.textContent).toContain("v1.0.0 (passkey-kit v0.14.0)");
    expect(changelogBox.textContent).toContain("Canonical v1 smart-wallet contract");

    const link = screen.getByTestId("wallet-upgrade-changelog-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(WALLET_WASM_CHANGELOG[PINNED_HASH]!.changelogUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByTestId("wallet-upgrade-changelog-fallback")).toBeNull();
  });

  it("shows a sensible fallback without a broken link when no changelog entry exists for the target wasm hash", () => {
    useWalletVersionMock.mockReturnValue({
      data: {
        state: "upgrade-available",
        currentHash: OLD_HASH,
        targetHash: UNKNOWN_HASH,
      },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<WalletUpgradeCard session={session} />);

    const fallback = screen.getByTestId("wallet-upgrade-changelog-fallback");
    expect(fallback.textContent).toMatch(/no changelog entry is published yet/i);
    expect(fallback.textContent).toContain(UNKNOWN_HASH.slice(0, 12));
    expect(screen.queryByTestId("wallet-upgrade-changelog-link")).toBeNull();
  });
});
