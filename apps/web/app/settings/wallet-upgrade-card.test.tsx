import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WalletChangelogNote } from "./wallet-upgrade-card";
import { walletChangelog } from "@/lib/wallet-changelog";

const PINNED = walletChangelog[0]!.wasmHash;
const UNKNOWN = "ab".repeat(32);

describe("WalletUpgradeCard — changelog note (#572)", () => {
  it("shows the summary and a changelog link when an entry exists", () => {
    render(<WalletChangelogNote wasmHash={PINNED} />);
    expect(screen.getByTestId("wallet-changelog-summary")).toBeDefined();
    const link = screen.getByTestId("wallet-changelog-link") as HTMLAnchorElement;
    expect(link.href).toMatch(/^https:/);
    expect(link.rel).toContain("noopener");
    expect(screen.queryByTestId("wallet-changelog-fallback")).toBeNull();
  });

  it("shows a sensible fallback instead of a broken link when no entry exists", () => {
    render(<WalletChangelogNote wasmHash={UNKNOWN} />);
    expect(screen.getByTestId("wallet-changelog-fallback")).toBeDefined();
    expect(screen.queryByTestId("wallet-changelog-link")).toBeNull();
    expect(screen.queryByTestId("wallet-changelog-summary")).toBeNull();
  });
});
