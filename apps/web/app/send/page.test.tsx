// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import { WalletProvider } from "@/lib/wallet-context";
import SendSwapPage, {
  KNOWN_MEMO_REQUIRED_DESTINATIONS,
  requiresDestinationMemo,
  shouldWarnMissingMemo,
} from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/send",
}));

vi.mock("@/lib/balances", () => ({
  useBalances: () => ({
    data: [{ symbol: "XLM", contractId: "CNATIVE", decimals: 7, amount: 100_000_000n }],
    isPending: false,
    refetch: vi.fn(),
  }),
}));

const session: WalletSession = {
  accountId: "CSENDER573",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T09:00:00.000Z",
  lastActiveAt: "2026-07-16T09:00:00.000Z",
};

const EXCHANGE_DESTINATION = "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM";

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.localStorage.setItem("vellar.session", JSON.stringify(session));
});

describe("SendSwapPage memo-required destination warning (#573)", () => {
  it("identifies known memo-required custodial addresses and suppresses warnings for muxed/contract addresses", () => {
    expect(KNOWN_MEMO_REQUIRED_DESTINATIONS.has(EXCHANGE_DESTINATION)).toBe(true);
    expect(requiresDestinationMemo(EXCHANGE_DESTINATION)).toEqual({
      required: true,
      entityName: "Coinbase",
    });
    expect(
      requiresDestinationMemo(
        "MA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGAAAAAAAAAAAAAB7I",
      ),
    ).toEqual({
      required: false,
    });
    expect(shouldWarnMissingMemo(EXCHANGE_DESTINATION, "")).toEqual(
      expect.objectContaining({
        warn: true,
        entityName: "Coinbase",
      }),
    );
    expect(shouldWarnMissingMemo(EXCHANGE_DESTINATION, "memo-999")).toEqual({
      warn: false,
      entityName: "Coinbase",
    });
  });

  it("warns on /send when a memo-required destination is entered without a memo and clears the warning once a memo is provided", async () => {
    render(
      <WalletProvider>
        <SendSwapPage />
      </WalletProvider>,
    );

    const recipientInput = await screen.findByLabelText(/recipient/i);
    fireEvent.change(recipientInput, { target: { value: EXCHANGE_DESTINATION } });

    const warning = await screen.findByTestId("memo-required-warning");
    expect(warning.textContent).toMatch(/Coinbase requires a memo \/ destination tag/i);

    const memoInput = screen.getByLabelText(/memo \/ destination tag/i);
    fireEvent.change(memoInput, { target: { value: "tag-42" } });

    await waitFor(() => expect(screen.queryByTestId("memo-required-warning")).toBeNull());
  });
});
