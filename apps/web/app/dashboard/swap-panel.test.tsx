import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assetsFor, type RegisteredAsset } from "@/lib/assets";
import type { PreparedSwap, SwapClient } from "@/lib/swap/client";
import { SwapQuoteError } from "@/lib/swap/quote";
import { SwapVenueError } from "@/lib/swap/soroswap";
import { WalletProvider } from "@/lib/wallet-context";
import { classifySwapFill, SwapPanel } from "./swap-panel";

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

  it("reports a partial fill with what filled and the residual left unswapped", async () => {
    // 10 XLM in, but only 4 XLM was actually swapped: 6 XLM stays put.
    const swaps = swapClient({
      readOutcome: vi.fn(async () => ({
        status: "success" as const,
        amounts: [40_000_000n, 4_200_000n],
      })),
    });
    const { onSuccess } = renderSwap(swaps);
    await quoteAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/partially filled/i);
    expect(status.textContent).toMatch(/Sold 4 XLM/);
    expect(status.textContent).toMatch(/of 10 XLM/);
    expect(status.textContent).toMatch(/received 0\.42 USDC/);
    expect(status.textContent).toMatch(/6 XLM/);
    expect(status.textContent).toMatch(/remains unswapped/i);
    // Distinct from a full fill and from a rejection.
    expect(screen.queryByText(/Swap confirmed/i)).toBeNull();
    expect(screen.queryByText(/fully rejected/i)).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("reports a 0% fill as fully rejected, distinct from a partial fill", async () => {
    const swaps = swapClient({
      readOutcome: vi.fn(async () => ({
        status: "success" as const,
        amounts: [100_000_000n, 0n],
      })),
    });
    const { onSuccess } = renderSwap(swaps);
    await quoteAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    expect(await screen.findByText(/filled 0% and was fully rejected/i)).toBeDefined();
    expect(screen.getByText(/no tokens were exchanged/i)).toBeDefined();
    // Not conflated with a partial fill or a full fill.
    expect(screen.queryByText(/partially filled/i)).toBeNull();
    expect(screen.queryByText(/Swap confirmed/i)).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
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

describe("classifySwapFill", () => {
  const AMOUNT_IN = 100_000_000n;

  it("classifies a full fill as success, including when output slipped", () => {
    expect(
      classifySwapFill({ status: "success", amounts: [AMOUNT_IN, 10_530_000n] }, AMOUNT_IN),
    ).toEqual({ kind: "success", received: 10_530_000n });
  });

  it("classifies a residual source balance as a partial fill", () => {
    expect(
      classifySwapFill({ status: "success", amounts: [40_000_000n, 4_200_000n] }, AMOUNT_IN),
    ).toEqual({
      kind: "partial",
      filledIn: 40_000_000n,
      residualIn: 60_000_000n,
      received: 4_200_000n,
    });
  });

  it("classifies a 0% fill as rejected, not partial", () => {
    expect(classifySwapFill({ status: "success", amounts: [AMOUNT_IN, 0n] }, AMOUNT_IN)).toEqual({
      kind: "rejected",
    });
    expect(classifySwapFill({ status: "success", amounts: [0n, 0n] }, AMOUNT_IN)).toEqual({
      kind: "rejected",
    });
  });

  it("classifies failed and unreadable outcomes", () => {
    expect(classifySwapFill({ status: "failed" }, AMOUNT_IN)).toEqual({ kind: "failed" });
    expect(classifySwapFill({ status: "unknown" }, AMOUNT_IN)).toEqual({
      kind: "success",
      received: null,
    });
  });
});
