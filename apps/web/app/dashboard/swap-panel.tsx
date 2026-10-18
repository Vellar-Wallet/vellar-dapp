"use client";

import { useState } from "react";
import type { Network } from "@vellar/types";
import { formatTokenAmount, parseTokenAmount } from "vellar-sdk";
import { isUserCancellation } from "@vellar/passkey";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { assetsFor, findAssetByContractId, findAssetById } from "@/lib/assets";
import { walletErrorMessage } from "@/lib/messages";
import type { PreparedSwap } from "@/lib/swap/client";
import {
  DEFAULT_SLIPPAGE_BPS,
  isQuoteFresh,
  parseSlippagePercent,
  SwapQuoteError,
  type SwapQuote,
} from "@/lib/swap/quote";
import { SwapVenueError, toVenueError, type SwapOutcome } from "@/lib/swap/soroswap";
import { trackTransaction } from "@/lib/track";
import { useSwapClient } from "@/lib/wallet-context";

// Swap flow (issue #407): quote from the venue -> explicit review stating the
// minimum received and worst-case rate -> passkey sign -> submit -> read the
// actual on-chain result. Nothing is signed before the user confirms.

type Flow =
  | { step: "form" }
  | { step: "review"; prepared: PreparedSwap; quote: SwapQuote }
  | { step: "submitting"; prepared: PreparedSwap; quote: SwapQuote }
  | { step: "tracking"; hash: string; prepared: PreparedSwap }
  | { step: "done"; hash: string; prepared: PreparedSwap; outcome: DoneOutcome };

export type DoneOutcome =
  | { kind: "success"; received: bigint | null }
  | {
      kind: "partial";
      filledIn: bigint;
      remainingIn: bigint;
      received: bigint;
      fillPercent: string;
    }
  | { kind: "failed" }
  | { kind: "unconfirmed" };

/**
 * Classify a swap's on-chain execution outcome against the requested input
 * amount (`requestedIn`):
 * - 0% filled (`status === "failed"`, `filledIn <= 0n`, or `received === 0n`)
 *   is classified as `{ kind: "failed" }` (fully rejected, nothing exchanged).
 * - `0n < filledIn < requestedIn` (or `status === "partial"` with residual
 *   unswapped balance) is classified as `{ kind: "partial" }` with exact
 *   `filledIn`, `remainingIn`, `received`, and `fillPercent`.
 * - Full fill (`filledIn >= requestedIn`) is classified as `{ kind: "success" }`.
 */
export function classifySwapExecution(
  requestedIn: bigint,
  outcome: SwapOutcome | null,
): DoneOutcome {
  if (!outcome || outcome.status === "unknown") {
    return { kind: "success", received: null };
  }
  if (outcome.status === "failed") {
    return { kind: "failed" };
  }

  const filledIn =
    "filledAmountIn" in outcome && outcome.filledAmountIn !== undefined
      ? outcome.filledAmountIn
      : (outcome.amounts[0] ?? requestedIn);
  const received =
    outcome.amounts.length > 0 ? (outcome.amounts[outcome.amounts.length - 1] ?? null) : null;

  if (filledIn <= 0n || received === 0n) {
    return { kind: "failed" };
  }

  const remainingIn =
    "remainingAmountIn" in outcome && outcome.remainingAmountIn !== undefined
      ? outcome.remainingAmountIn
      : requestedIn > filledIn
        ? requestedIn - filledIn
        : 0n;

  if (remainingIn > 0n) {
    const bps = requestedIn > 0n ? Number((filledIn * 10_000n) / requestedIn) : 0;
    const fillPercent = (bps / 100).toString();
    return {
      kind: "partial",
      filledIn,
      remainingIn,
      received: received ?? 0n,
      fillPercent,
    };
  }

  return { kind: "success", received };
}

function errorMessage(err: unknown): string {
  if (err instanceof SwapQuoteError || err instanceof SwapVenueError) return err.message;
  if (err instanceof Error && /Error\(Contract, #\d+\)/.test(err.message)) {
    return toVenueError(err).message;
  }
  return walletErrorMessage(err);
}

function fmt(amount: bigint, decimals: number, symbol: string): string {
  return `${formatTokenAmount(amount, decimals)} ${symbol}`;
}

export function SwapPanel({
  from,
  network,
  onSuccess,
}: {
  from: string;
  network: Network;
  onSuccess: () => void;
}) {
  const getSwaps = useSwapClient();
  const assets = assetsFor(network);
  const [sellId, setSellId] = useState(assets[0]?.id ?? "native");
  const [buyId, setBuyId] = useState(assets[1]?.id ?? "native");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState((DEFAULT_SLIPPAGE_BPS / 100).toString());
  const [flow, setFlow] = useState<Flow>({ step: "form" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = (contractId: string) => findAssetByContractId(network, contractId);

  async function quoteAndPrepare() {
    setError(null);
    setBusy(true);
    try {
      const sell = findAssetById(network, sellId);
      const buy = findAssetById(network, buyId);
      if (!sell || !buy) throw new SwapQuoteError("Pick two supported assets.");
      const slippageBps = parseSlippagePercent(slippage);
      const amountIn = parseTokenAmount(amount, sell.decimals);
      const swaps = await getSwaps();
      const quote = await swaps.quote({ sell, buy, amountIn, resolve });
      const prepared = await swaps.prepare({ from, quote, slippageBps, resolve });
      setFlow({ step: "review", prepared, quote });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(prepared: PreparedSwap, quote: SwapQuote) {
    if (!isQuoteFresh(quote, Date.now())) {
      setError("This quote has expired. Get a fresh quote before approving.");
      setFlow({ step: "form" });
      return;
    }
    setError(null);
    setFlow({ step: "submitting", prepared, quote });
    let hash: string;
    try {
      ({ hash } = await prepared.confirm());
    } catch (err) {
      if (!isUserCancellation(err)) {
        console.error("swap confirm failed", err);
        setError(errorMessage(err));
      }
      setFlow({ step: "review", prepared, quote });
      return;
    }

    setFlow({ step: "tracking", hash, prepared });
    let result: "success" | "failed";
    try {
      result = await trackTransaction(hash);
    } catch {
      setFlow({ step: "done", hash, prepared, outcome: { kind: "unconfirmed" } });
      return;
    }
    if (result === "failed") {
      setFlow({ step: "done", hash, prepared, outcome: { kind: "failed" } });
      return;
    }
    let rawOutcome: SwapOutcome | null = null;
    try {
      const swaps = await getSwaps();
      rawOutcome = await swaps.readOutcome(hash);
    } catch {
      rawOutcome = null;
    }
    const outcome = classifySwapExecution(prepared.review.amountIn, rawOutcome);
    setFlow({ step: "done", hash, prepared, outcome });
    if (outcome.kind === "success" || outcome.kind === "partial") {
      setAmount(
        outcome.kind === "partial"
          ? formatTokenAmount(outcome.remainingIn, prepared.review.sell.decimals)
          : "",
      );
      onSuccess();
    }
  }

  return (
    <section className="lpa-panel">
      <Eyebrow>Swap</Eyebrow>

      {flow.step === "form" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void quoteAndPrepare();
          }}
          className="mt-3.5 flex flex-col gap-3"
        >
          <label className="lpa-field">
            <span className="flabel">You pay</span>
            <select value={sellId} onChange={(e) => setSellId(e.target.value)}>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.symbol}
                </option>
              ))}
            </select>
          </label>
          <label className="lpa-field">
            <span className="flabel">Amount</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              inputMode="decimal"
            />
          </label>
          <label className="lpa-field">
            <span className="flabel">You receive</span>
            <select value={buyId} onChange={(e) => setBuyId(e.target.value)}>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.symbol}
                </option>
              ))}
            </select>
          </label>
          <label className="lpa-field">
            <span className="flabel">Max slippage (%)</span>
            <input
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              inputMode="decimal"
            />
          </label>
          <LpActionButton type="submit" disabled={busy} className="self-start">
            {busy ? "Getting quote…" : "Get quote"}
          </LpActionButton>
          <p className="text-[12px] text-[var(--lp-ink-soft)]">
            Quotes come from Soroswap pool reserves on-chain. No fiat value is shown: there is no
            on-chain price oracle to base one on.
          </p>
        </form>
      )}

      {(flow.step === "review" || flow.step === "submitting") && (
        <SwapReviewDialog
          prepared={flow.prepared}
          submitting={flow.step === "submitting"}
          onConfirm={() => void confirm(flow.prepared, flow.quote)}
          onCancel={() => setFlow({ step: "form" })}
        />
      )}

      {flow.step === "tracking" && (
        <p className="mt-3.5! animate-pulse text-sm text-[var(--lp-ink-soft)]">
          Confirming on the network…{" "}
          <span className="break-all font-[family-name:var(--lp-mono)]">{flow.hash}</span>
        </p>
      )}

      {flow.step === "done" && (
        <div className="mt-3.5 flex flex-col gap-2 text-sm">
          {flow.outcome.kind === "success" && (
            <p className="lpa-ok" data-testid="swap-full-fill">
              Swap confirmed.
              {flow.outcome.received !== null
                ? ` Received ${fmt(flow.outcome.received, flow.prepared.review.buy.decimals, flow.prepared.review.buy.symbol)}.`
                : " Check your balance for the exact amount received."}
            </p>
          )}
          {flow.outcome.kind === "partial" && (
            <div
              role="status"
              data-testid="swap-partial-fill"
              className="lpa-well border-l-[3px]! border-l-[var(--lp-sun)]! flex flex-col gap-2"
            >
              <p className="m-0! font-bold text-[var(--lp-ink)]">
                Swap partially filled ({flow.outcome.fillPercent}%).
              </p>
              <p className="m-0! text-[13px] text-[var(--lp-ink-soft)]">
                Swapped{" "}
                <strong>
                  {fmt(
                    flow.outcome.filledIn,
                    flow.prepared.review.sell.decimals,
                    flow.prepared.review.sell.symbol,
                  )}
                </strong>{" "}
                for{" "}
                <strong>
                  {fmt(
                    flow.outcome.received,
                    flow.prepared.review.buy.decimals,
                    flow.prepared.review.buy.symbol,
                  )}
                </strong>
                . Your remaining unswapped balance of{" "}
                <strong data-testid="swap-remaining-balance">
                  {fmt(
                    flow.outcome.remainingIn,
                    flow.prepared.review.sell.decimals,
                    flow.prepared.review.sell.symbol,
                  )}
                </strong>{" "}
                is still in your wallet.
              </p>
              <dl className="m-0 flex flex-col gap-1 text-xs">
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--lp-ink-faint)]">Filled amount</dt>
                  <dd className="m-0 font-[family-name:var(--lp-mono)]">
                    {fmt(
                      flow.outcome.filledIn,
                      flow.prepared.review.sell.decimals,
                      flow.prepared.review.sell.symbol,
                    )}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--lp-ink-faint)]">Received amount</dt>
                  <dd className="m-0 font-[family-name:var(--lp-mono)]">
                    {fmt(
                      flow.outcome.received,
                      flow.prepared.review.buy.decimals,
                      flow.prepared.review.buy.symbol,
                    )}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--lp-ink-faint)]">Residual unswapped balance</dt>
                  <dd className="m-0 font-[family-name:var(--lp-mono)]">
                    {fmt(
                      flow.outcome.remainingIn,
                      flow.prepared.review.sell.decimals,
                      flow.prepared.review.sell.symbol,
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          )}
          {flow.outcome.kind === "failed" && (
            <p className="lpa-bad" data-testid="swap-failed">
              Swap failed on the network. A Soroban swap is all-or-nothing, so no tokens were
              exchanged.
            </p>
          )}
          {flow.outcome.kind === "unconfirmed" && (
            <p className="lpa-bad">
              The network hasn&apos;t confirmed this swap yet. Check your balance before trying
              again.
            </p>
          )}
          <p className="break-all font-[family-name:var(--lp-mono)] text-xs text-[var(--lp-ink-faint)]">
            {flow.hash}
          </p>
          <LpActionButton
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setFlow({ step: "form" })}
          >
            {flow.outcome.kind === "partial" ? "Swap remaining balance" : "New swap"}
          </LpActionButton>
        </div>
      )}

      {error && (
        <p role="alert" className="lpa-bad mt-3.5! text-sm">
          {error}
        </p>
      )}
    </section>
  );
}

function SwapReviewDialog({
  prepared,
  submitting,
  onConfirm,
  onCancel,
}: {
  prepared: PreparedSwap;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const r = prepared.review;
  const rows: [string, string][] = [
    ["You pay", fmt(r.amountIn, r.sell.decimals, r.sell.symbol)],
    ["Expected to receive", fmt(r.expectedOut, r.buy.decimals, r.buy.symbol)],
    ["Minimum received", fmt(r.minOut, r.buy.decimals, r.buy.symbol)],
    ["Quoted rate", `1 ${r.sell.symbol} = ${r.rate} ${r.buy.symbol}`],
    ["Worst-case rate", `1 ${r.sell.symbol} = ${r.worstRate} ${r.buy.symbol}`],
    ["Max slippage", `${r.slippageBps / 100}%`],
    ["Route", r.route.map((a) => a.symbol).join(" → ")],
    ["Venue", `${r.venue} router ${r.router}`],
    ["Network", r.network.toUpperCase()],
  ];
  return (
    <div role="dialog" aria-label="Review swap" className="mt-3.5 flex flex-col gap-3">
      <span className="lpa-ok self-start text-[13px] font-bold">
        ✓ Review before signing — this cannot be undone
      </span>
      <dl className="lpa-well flex flex-col gap-2.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-[var(--lp-ink-faint)]">{label}</dt>
            <dd className="break-all text-right font-[family-name:var(--lp-mono)] text-xs">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[12px] leading-relaxed text-[var(--lp-ink-soft)]">
        The transaction itself refuses to execute below the minimum: if the price moves further than{" "}
        {r.slippageBps / 100}% before it lands, the swap fails and nothing is exchanged.
      </p>
      <div className="flex gap-3">
        <LpActionButton onClick={onConfirm} disabled={submitting}>
          {submitting ? "Signing…" : "Confirm with passkey"}
        </LpActionButton>
        <LpActionButton variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </LpActionButton>
      </div>
    </div>
  );
}
