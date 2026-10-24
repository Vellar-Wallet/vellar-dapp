"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { Network } from "@vellar/types";
import { formatTokenAmount, type PreparedPayment, type TokenInfo } from "vellar-sdk";
import { isUserCancellation } from "@vellar/passkey";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { walletErrorMessage } from "@/lib/messages";
import { trackTransaction } from "@/lib/track";
import { usePaymentClient } from "@/lib/wallet-context";
import { getSupportedTokens, parseAmountWithDecimals, TESTNET_NATIVE_SAC } from "@/lib/tokens";
import { isMemoRequiredDestination } from "@/lib/memo-destinations";

// Send flow (technical-doc.md §7.4): build -> explicit review -> passkey sign
// -> submit -> track until final. Signing only ever happens from the review
// step after the user clicks confirm — no silent signing (§8).
//
// A SEP-7 payment request (app/pay) enters through the SAME flow: it only
// prefills the form (destination locked, amount locked if requested) and adds
// the request's origin + message to the review. It never skips a step.

/** Where a prefilled payment came from, shown on the form and the review (§8.2). */
export interface PaymentRequestContext {
  /** Verified SEP-7 origin domain, or null when the request is unsigned. */
  originDomain: string | null;
  /** The requester's note — untrusted, rendered as plain text only. */
  msg?: string;
}

/** A token as the dashboard knows it: `amount` is present when the balance has
 * been loaded locally (TokenBalance), absent for a plain registry token. */
type SendableToken = TokenInfo & { amount?: bigint };

/**
 * Locally known balance for a token, or null when we don't have one. This is a
 * UX check only — the server-side balance guard at prepare/submit stays the
 * authoritative one.
 */
export function knownBalance(token: SendableToken, tokens: SendableToken[]): bigint | null {
  const match = tokens.find((t) => t.contractId === token.contractId);
  const amount = match?.amount ?? token.amount;
  return typeof amount === "bigint" ? amount : null;
}

const formSchema = z.object({
  to: z.string().trim().min(1, "Recipient is required"),
  amount: z.string().trim().min(1, "Amount is required"),
  memo: z.string().trim().optional(),
});

type FormValues = z.infer<typeof formSchema>;

type FlowState =
  | { step: "form" }
  | { step: "review"; prepared: PreparedPayment }
  | { step: "submitting"; prepared: PreparedPayment }
  | { step: "tracking"; hash: string }
  | { step: "done"; hash: string; result: "success" | "failed" };

export function SendPayment({
  from,
  token: initialToken,
  availableTokens,
  network,
  onSuccess,
  prefill,
  request,
}: {
  from: string;
  token?: TokenInfo;
  availableTokens?: SendableToken[];
  network: Network;
  onSuccess: () => void;
  prefill?: { to: string; amount?: string };
  request?: PaymentRequestContext;
}) {
  const getPayments = usePaymentClient();
  const [flow, setFlow] = useState<FlowState>({ step: "form" });
  const [error, setError] = useState<string | null>(null);

  const supported: SendableToken[] =
    availableTokens && availableTokens.length > 0 ? availableTokens : getSupportedTokens(network);

  const [selectedToken, setSelectedToken] = useState<SendableToken>(
    initialToken ??
      supported[0] ?? {
        symbol: "XLM",
        decimals: 7,
        contractId: TESTNET_NATIVE_SAC,
      },
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { to: prefill?.to ?? "", amount: prefill?.amount ?? "", memo: "" },
  });

  /** Inline pre-signing check against the locally known balance. Returns true
   * when the amount is fine (or we have no balance to check against). */
  function checkLocalBalance(amount: bigint): boolean {
    const balance = knownBalance(selectedToken, supported);
    if (balance !== null && amount > balance) {
      setError(
        `Insufficient ${selectedToken.symbol} balance: you have ${formatTokenAmount(
          balance,
          selectedToken.decimals,
        )} ${selectedToken.symbol}.`,
      );
      return false;
    }
    return true;
  }

  async function prepare(values: FormValues) {
    setError(null);
    try {
      const amount = parseAmountWithDecimals(values.amount, selectedToken.decimals);
      if (!checkLocalBalance(amount)) return;
      const payments = await getPayments();
      const prepared = await payments.preparePayment({
        from,
        to: values.to,
        token: selectedToken,
        amount,
      });
      setFlow({ step: "review", prepared });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't prepare the payment.");
    }
  }

  async function confirm(prepared: PreparedPayment) {
    // Re-check at signing time: the balance may have dropped since the form
    // loaded. The server-side check remains authoritative either way.
    if (!checkLocalBalance(prepared.review.amount)) return;
    setFlow({ step: "submitting", prepared });
    setError(null);
    let hash: string;
    try {
      ({ hash } = await prepared.confirm());
    } catch (err) {
      if (isUserCancellation(err)) {
        // Changing your mind at the passkey prompt returns you to review.
        setFlow({ step: "review", prepared });
      } else {
        // Surface the raw failure for diagnostics; the user sees mapped copy.
        console.error("payment confirm failed", err);
        setError(walletErrorMessage(err));
        setFlow({ step: "review", prepared });
      }
      return;
    }

    setFlow({ step: "tracking", hash });
    try {
      const result = await trackTransaction(hash);
      setFlow({ step: "done", hash, result });
      if (result === "success") {
        form.reset();
        onSuccess();
      }
    } catch {
      setError("The network hasn't confirmed the transaction yet. Check again shortly.");
      setFlow({ step: "done", hash, result: "failed" });
    }
  }

  return (
    <section className="lpa-panel">
      <Eyebrow>Send {selectedToken.symbol}</Eyebrow>

      {request && <RequestBanner request={request} />}

      {flow.step === "form" && (
        <form
          onSubmit={(e) => void form.handleSubmit(prepare)(e)}
          className="mt-3.5 flex flex-col gap-3"
        >
          {supported.length > 1 && prefill === undefined && (
            <label className="lpa-field">
              <span className="flabel">Asset</span>
              <select
                aria-label="Select asset"
                value={selectedToken.contractId}
                onChange={(e) => {
                  const match = supported.find((t) => t.contractId === e.target.value);
                  if (match) setSelectedToken(match);
                }}
                className="w-full rounded border border-[var(--lp-border)] bg-[var(--lp-paper)] px-3 py-2 text-sm text-[var(--lp-ink)]"
              >
                {supported.map((t) => (
                  <option key={t.contractId} value={t.contractId}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="lpa-field">
            <span className="flabel">Recipient</span>
            <input
              {...form.register("to")}
              placeholder="G... or C..."
              readOnly={prefill !== undefined}
            />
            {form.formState.errors.to && (
              <span className="ferror">{form.formState.errors.to.message}</span>
            )}
          </label>
          <label className="lpa-field">
            <span className="flabel">Amount ({selectedToken.symbol})</span>
            <input
              {...form.register("amount")}
              placeholder="0.0"
              inputMode="decimal"
              readOnly={prefill?.amount !== undefined}
            />
            {form.formState.errors.amount && (
              <span className="ferror">{form.formState.errors.amount.message}</span>
            )}
          </label>
          <label className="lpa-field">
            <span className="flabel">Memo (optional)</span>
            <input
              {...form.register("memo")}
              placeholder="Memo or destination tag"
            />
          </label>
          {showMemoWarning && (
            <p role="alert" className="lpa-bad text-xs" data-testid="memo-warning">
              Warning: This destination requires a memo (destination tag). Sending without a memo may result in lost funds.
            </p>
          )}
          <LpActionButton
            type="submit"
            disabled={form.formState.isSubmitting}
            className="self-start"
          >
            {form.formState.isSubmitting ? "Preparing…" : "Review payment"}
          </LpActionButton>
        </form>
      )}

      {(flow.step === "review" || flow.step === "submitting") && (
        <div role="dialog" aria-label="Review payment" className="mt-3.5 flex flex-col gap-3">
          <span className="lpa-ok self-start text-[13px] font-bold">
            ✓ Review before signing — this cannot be undone
          </span>
          {isMemoRequiredDestination(flow.prepared.review.to) && (!memoValue || memoValue.trim() === "") && (
            <p role="alert" className="lpa-bad text-xs" data-testid="review-memo-warning">
              Warning: This destination requires a memo (destination tag). Sending without a memo may result in lost funds.
            </p>
          )}
          <dl className="lpa-well flex flex-col gap-2.5 text-sm">
            {(
              [
                ...(request
                  ? ([["Requested by", request.originDomain ?? "Unverified source"]] as const)
                  : []),
                ["From", flow.prepared.review.from],
                ["To", flow.prepared.review.to],
                ["Token contract", flow.prepared.review.token.contractId],
                ...(memoValue && memoValue.trim() ? ([["Memo", memoValue.trim()]] as const) : []),
                ...(request?.msg ? ([["Message", request.msg]] as const) : []),
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-[var(--lp-ink-faint)]">{label}</dt>
                <dd className="break-all text-right font-[family-name:var(--lp-mono)] text-xs">
                  {value}
                </dd>
              </div>
            ))}
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--lp-ink-faint)]">Asset</dt>
              <dd className="font-bold text-[var(--lp-ink)]">
                {flow.prepared.review.token.symbol}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--lp-ink-faint)]">Amount</dt>
              <dd className="lpa-amt text-xl">
                {formatTokenAmount(
                  flow.prepared.review.amount,
                  flow.prepared.review.token.decimals,
                )}{" "}
                {flow.prepared.review.token.symbol}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--lp-ink-faint)]">Network</dt>
              <dd className="uppercase">{flow.prepared.review.network}</dd>
            </div>
          </dl>
          <div className="flex gap-3">
            <LpActionButton
              onClick={() => void confirm(flow.prepared)}
              disabled={flow.step === "submitting"}
            >
              {flow.step === "submitting" ? "Signing…" : "Confirm with passkey"}
            </LpActionButton>
            <LpActionButton
              variant="outline"
              onClick={() => setFlow({ step: "form" })}
              disabled={flow.step === "submitting"}
            >
              Cancel
            </LpActionButton>
          </div>
        </div>
      )}

      {flow.step === "tracking" && (
        <p className="mt-3.5! animate-pulse text-sm text-[var(--lp-ink-soft)]">
          Confirming on the network…{" "}
          <span className="break-all font-[family-name:var(--lp-mono)]">{flow.hash}</span>
        </p>
      )}

      {flow.step === "done" && (
        <div className="mt-3.5 flex flex-col gap-2 text-sm">
          <p className={flow.result === "success" ? "lpa-ok" : "lpa-bad"}>
            {flow.result === "success" ? "Payment confirmed." : "Payment failed on the network."}
          </p>
          <p className="break-all font-[family-name:var(--lp-mono)] text-xs text-[var(--lp-ink-faint)]">
            {flow.hash}
          </p>
          <LpActionButton
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setFlow({ step: "form" })}
          >
            Send another
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

function RequestBanner({ request }: { request: PaymentRequestContext }) {
  return (
    <div className="lpa-well mt-3.5 flex flex-col gap-1.5 text-[13px]">
      {request.originDomain ? (
        <p className="m-0!">
          Payment request from <strong>{request.originDomain}</strong> (signature verified against
          its stellar.toml).
        </p>
      ) : (
        <p className="m-0!">
          Payment request from an <strong>unverified source</strong> — anyone can create a payment
          link. Check the recipient before you pay.
        </p>
      )}
      {request.msg && (
        <p className="m-0! break-words text-[var(--lp-ink-soft)]">
          Their message: &ldquo;{request.msg}&rdquo;
        </p>
      )}
      <p className="m-0! text-[var(--lp-ink-soft)]">
        Nothing is sent until you review and confirm with your passkey.
      </p>
    </div>
  );
}
