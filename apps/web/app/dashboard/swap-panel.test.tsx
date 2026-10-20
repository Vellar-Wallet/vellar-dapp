import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assetsFor, type RegisteredAsset } from "@/lib/assets";
import type { PreparedSwap, SwapClient } from "@/lib/swap/client";
import { SwapQuoteError } from "@/lib/swap/quote";
import { SwapVenueError } from "@/lib/swap/soroswap";
import { WalletProvider } from "@/lib/wallet-context";
import { classifySwapExecution, SwapPanel } from "./swap-panel";

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("@/lib/track", () => ({ trackTransaction: trackMock }));

const [XLM, USDC] = assetsFor("testnet") as [RegisteredAsset, RegisteredAsset];
const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function prepared(confirm = vi.fn().mockResolvedValue({ hash: "swaphash" })): PreparedSwap {
  return {
    review: {
      from: WALLET,
      network: "testnet",
      venue: "Soroswap",
      router: "CROUTER",
      sell: XLM,
      buy: USDC,
      amountIn: 100_000_000n,
      expectedOut: 10_540_793n,
      minOut: 10_488_089n,
      slippageBps: 50,
      rate: "0.1054079",
      worstRate: "0.1048808",
      route: [XLM, USDC],
    },
    confirm,
  };
}

function swapClient(overrides: Partial<SwapClient> = {}): SwapClient {
  return {
    quote: vi.fn(async ({ sell, buy, amountIn }) => ({
      sell,
      buy,
      amountIn,
      expectedOut: 10_540_793n,
      path: [sell.contractId, buy.contractId],
      hopAmounts: [amountIn, 10_540_793n],
      quotedAt: Date.now(),
    })),
    prepare: vi.fn(async () => prepared()),
    readOutcome: vi.fn(async () => ({
      status: "success" as const,
      amounts: [100_000_000n, 10_530_000n],
    })),
    ...overrides,
  };
}

function renderSwap(swaps: SwapClient, onSuccess = vi.fn()) {
  render(
    <WalletProvider swaps={swaps}>
      <SwapPanel from={WALLET} network="testnet" onSuccess={onSuccess} />
    </WalletProvider>,
  );
  return { onSuccess };
}

async function quoteAndReview(amount = "10", slippage = "0.5") {
  fireEvent.change(screen.getByLabelText(/^amount/i), { target: { value: amount } });
  fireEvent.change(screen.getByLabelText(/slippage/i), { target: { value: slippage } });
  fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
  return screen.findByRole("dialog", { name: /review swap/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  trackMock.mockResolvedValue("success");
});

describe("SwapPanel", () => {
  it("offers only registry assets and labels the absence of a fiat price", () => {
    renderSwap(swapClient());
    const opts = Array.from((screen.getByLabelText(/you pay/i) as HTMLSelectElement).options);
    expect(opts.map((o) => o.textContent)).toEqual(["XLM", "USDC"]);
    expect(screen.getByText(/no on-chain price oracle/i)).toBeDefined();
  });

  it("quotes with the parsed slippage and shows every approval field", async () => {
    const swaps = swapClient();
    renderSwap(swaps);
    const dialog = await quoteAndReview("10", "0.5");

    expect(swaps.quote).toHaveBeenCalledWith(
      expect.objectContaining({ sell: XLM, buy: USDC, amountIn: 100_000_000n }),
    );
    expect(swaps.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ from: WALLET, slippageBps: 50 }),
    );
    const text = dialog.textContent ?? "";
    expect(text).toContain("10 XLM"); // input
    expect(text).toContain("1.0540793 USDC"); // expected
    expect(text).toMatch(/Minimum received.*1\.0488089 USDC/);
    expect(text).toContain("1 XLM = 0.1054079 USDC"); // quoted rate
    expect(text).toMatch(/Worst-case rate.*1 XLM = 0\.1048808 USDC/);
    expect(text).toContain("0.5%");
    expect(text).toContain("XLM → USDC");
    expect(text).toContain("Soroswap");
  });

  it("does not sign until the user confirms", async () => {
    const confirm = vi.fn().mockResolvedValue({ hash: "swaphash" });
    renderSwap(swapClient({ prepare: vi.fn(async () => prepared(confirm)) }));
    await quoteAndReview();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await screen.findByRole("button", { name: /get quote/i });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirms, tracks and reports the amount actually received", async () => {
    const swaps = swapClient();
    const { onSuccess } = renderSwap(swaps);
    await quoteAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    expect(await screen.findByText(/Received 1\.053 USDC/)).toBeDefined();
    expect(trackMock).toHaveBeenCalledWith("swaphash");
    expect(swaps.readOutcome).toHaveBeenCalledWith("swaphash");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("surfaces a partial fill outcome with both filled and remaining unswapped amounts", async () => {
    const swaps = swapClient({
      readOutcome: vi.fn(async () => ({
        status: "success" as const,
        // 6 XLM filled out of 10 XLM requested -> 0.6318 USDC received, 4 XLM unswapped
        amounts: [60_000_000n, 6_318_000n],
      })),
    });
    const { onSuccess } = renderSwap(swaps);
    await quoteAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    const partialCard = await screen.findByTestId("swap-partial-fill");
    expect(partialCard.textContent).toMatch(/Swap partially filled \(60%\)/i);
    expect(partialCard.textContent).toContain("Swapped 6 XLM for 0.6318 USDC");
    const remainingText = screen.getByTestId("swap-remaining-balance");
    expect(remainingText.textContent).toContain("4 XLM");
    expect(partialCard.textContent).toMatch(/remaining unswapped balance/i);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("treats a 0% fill (zero input or output exchanged) as a failed swap rather than a partial fill", async () => {
    const swaps = swapClient({
      readOutcome: vi.fn(async () => ({
        status: "success" as const,
        amounts: [0n, 0n],
      })),
    });
    const { onSuccess } = renderSwap(swaps);
    await quoteAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    expect(await screen.findByText(/swap failed on the network/i)).toBeDefined();
    expect(screen.getByText(/no tokens were exchanged/i)).toBeDefined();
    expect(screen.queryByTestId("swap-partial-fill")).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("classifies full, partial, and 0% swap executions accurately", () => {
    expect(
      classifySwapExecution(100_000_000n, {
        status: "success",
        amounts: [100_000_000n, 10_530_000n],
      }),
    ).toEqual({
      kind: "success",
      received: 10_530_000n,
    });

    expect(
      classifySwapExecution(100_000_000n, {
        status: "success",
        amounts: [60_000_000n, 6_318_000n],
      }),
    ).toEqual({
      kind: "partial",
      filledIn: 60_000_000n,
      remainingIn: 40_000_000n,
      received: 6_318_000n,
      fillPercent: "60",
    });

    expect(
      classifySwapExecution(100_000_000n, {
        status: "success",
        amounts: [0n, 0n],
      }),
    ).toEqual({ kind: "failed" });
  });

  it("reports an on-chain failure as failed, with no tokens exchanged", async () => {
    trackMock.mockResolvedValue("failed");
    const { onSuccess } = renderSwap(swapClient());
    await quoteAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    expect(await screen.findByText(/swap failed on the network/i)).toBeDefined();
    expect(screen.getByText(/no tokens were exchanged/i)).toBeDefined();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does not claim success when confirmation can't be read", async () => {
    trackMock.mockRejectedValue(new Error("timeout"));
    const { onSuccess } = renderSwap(swapClient());
    await quoteAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    expect(await screen.findByText(/hasn't confirmed this swap yet/i)).toBeDefined();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("surfaces a slippage revert at submission and stays on review", async () => {
    const confirm = vi.fn().mockRejectedValue(new Error("tx failed: Error(Contract, #507)"));
    renderSwap(swapClient({ prepare: vi.fn(async () => prepared(confirm)) }));
    await quoteAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/slippage limit/);
    expect(screen.getByRole("dialog", { name: /review swap/i })).toBeDefined();
  });

  it.each([
    [new SwapVenueError("Not enough liquidity in the pool for that amount.", 511), /liquidity/],
    [new SwapQuoteError("No route between these assets on the venue."), /No route/],
  ])("shows quote failures without a review: %s", async (err, message) => {
    renderSwap(swapClient({ quote: vi.fn().mockRejectedValue(err) }));
    fireEvent.change(screen.getByLabelText(/^amount/i), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejects an out-of-range slippage before quoting", async () => {
    const swaps = swapClient();
    renderSwap(swaps);
    fireEvent.change(screen.getByLabelText(/^amount/i), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/slippage/i), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Slippage/);
    expect(swaps.quote).not.toHaveBeenCalled();
  });

  it("refuses to confirm an expired quote", async () => {
    const confirm = vi.fn();
    const swaps = swapClient({
      quote: vi.fn(async ({ sell, buy, amountIn }) => ({
        sell,
        buy,
        amountIn,
        expectedOut: 1n,
        path: [sell.contractId, buy.contractId],
        hopAmounts: [amountIn, 1n],
        quotedAt: Date.now() - 60_000,
      })),
      prepare: vi.fn(async () => prepared(confirm)),
    });
    renderSwap(swaps);
    await quoteAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/expired/);
    expect(confirm).not.toHaveBeenCalled();
  });
});
