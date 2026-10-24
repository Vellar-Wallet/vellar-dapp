import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletProvider } from "@/lib/wallet-context";
import SendSwapPage, { isMemoRequiredDestination, MEMO_REQUIRED_DESTINATIONS } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/send",
}));

vi.mock("@/lib/balances", () => ({
  useBalances: () => ({
    data: [{ symbol: "XLM", contractId: "CNATIVE", decimals: 7 }],
    isPending: false,
    refetch: vi.fn(),
  }),
}));

describe("SendSwapPage (/send)", () => {
  it("exports maintained list and heuristic for memo-required destinations", () => {
    expect(MEMO_REQUIRED_DESTINATIONS.length).toBeGreaterThan(0);
    // Known exchange destinations
    expect(isMemoRequiredDestination("GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSBR54EB4YAWBDMW7SJBOMIB6J")).toBe(true);
    expect(isMemoRequiredDestination("GDQUOAQXF2ZNOYRLCGMWINPPMK3UXOMGVQHGMUMODBCPAG3HNOGJJEOG")).toBe(true);

    // Heuristics
    expect(
      isMemoRequiredDestination("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBMEMO"),
    ).toBe(true);

    // Standard user address without memo requirement
    expect(
      isMemoRequiredDestination("GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3"),
    ).toBe(false);
    expect(isMemoRequiredDestination("")).toBe(false);
    expect(isMemoRequiredDestination(null)).toBe(false);
  });

  it("renders send page structure", () => {
    render(
      <WalletProvider>
        <SendSwapPage />
      </WalletProvider>,
    );
    expect(screen.getByRole("tab", { name: "Send" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Swap" })).toBeDefined();
  });
});
