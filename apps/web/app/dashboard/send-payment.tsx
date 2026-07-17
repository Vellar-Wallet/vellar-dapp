"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { Network } from "@vela/types";
import {
  formatTokenAmount,
  parseTokenAmount,
  type PreparedPayment,
  type TokenInfo,
} from "@vela/wallet-sdk";
import { isUserCancellation } from "@vela/passkey";
import { walletErrorMessage } from "@/lib/messages";
import { trackTransaction } from "@/lib/track";
import { usePaymentClient } from "@/lib/wallet-context";

// Send flow (technical-doc.md §7.4): build -> explicit review -> passkey sign
// -> submit -> track until final. Signing only ever happens from the review
// step after the user clicks confirm — no silent signing (§8).

const formSchema = z.object({
  to: z.string().trim().min(1, "Recipient is required"),
  amount: z.string().trim().min(1, "Amount is required"),
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
  token,
  network,
  onSuccess,
}: {
  from: string;
  token: TokenInfo;
  network: Network;
  onSuccess: () => void;
}) {
  const getPayments = usePaymentClient();
  const [flow, setFlow] = useState<FlowState>({ step: "form" });
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { to: "", amount: "" },
  });

  async function prepare(values: FormValues) {
    setError(null);
    try {
      const amount = parseTokenAmount(values.amount, token.decimals);
      const payments = await getPayments();
      const prepared = await payments.preparePayment({ from, to: values.to, token, amount });
      setFlow({ step: "review", prepared });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't prepare the payment.");
    }
  }

  async function confirm(prepared: PreparedPayment) {
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
    <section className="neo" style={{ padding: 22 }}>
      <span className="eyebrow">Send {token.symbol}</span>

      {flow.step === "form" && (
        <form
          onSubmit={(e) => void form.handleSubmit(prepare)(e)}
          style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}
        >
          <label className="form-field">
            <span className="flabel">Recipient</span>
            <input {...form.register("to")} placeholder="G... or C..." />
            {form.formState.errors.to && (
              <span className="ferror">{form.formState.errors.to.message}</span>
            )}
          </label>
          <label className="form-field amount">
            <span className="flabel">Amount ({token.symbol})</span>
            <input {...form.register("amount")} placeholder="0.0" inputMode="decimal" />
            {form.formState.errors.amount && (
              <span className="ferror">{form.formState.errors.amount.message}</span>
            )}
          </label>
          <button
            type="submit"
            disabled={form.formState.isSubmitting}
            className="btn btn-signal"
            style={{ alignSelf: "flex-start" }}
          >
            {form.formState.isSubmitting ? "Preparing…" : "Review payment"}
          </button>
        </form>
      )}

      {(flow.step === "review" || flow.step === "submitting") && (
        <div
          role="dialog"
          aria-label="Review payment"
          style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}
        >
          <span className="verified" style={{ alignSelf: "flex-start", color: "var(--signal)" }}>
            ✓ Review before signing — this cannot be undone
          </span>
          <dl
            className="neo-inset"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              fontSize: 14,
              padding: "14px 16px",
            }}
          >
            {(
              [
                ["From", flow.prepared.review.from, true],
                ["To", flow.prepared.review.to, true],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                style={{ display: "flex", justifyContent: "space-between", gap: 16 }}
              >
                <dt className="lbl">{label}</dt>
                <dd
                  className="mono"
                  style={{ textAlign: "right", wordBreak: "break-all", fontSize: 12 }}
                >
                  {value}
                </dd>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <dt className="lbl">Amount</dt>
              <dd className="display" style={{ fontSize: 20 }}>
                {formatTokenAmount(
                  flow.prepared.review.amount,
                  flow.prepared.review.token.decimals,
                )}{" "}
                {flow.prepared.review.token.symbol}
              </dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <dt className="lbl">Network</dt>
              <dd style={{ textTransform: "uppercase" }}>{flow.prepared.review.network}</dd>
            </div>
          </dl>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => void confirm(flow.prepared)}
              disabled={flow.step === "submitting"}
              className="btn btn-signal"
            >
              {flow.step === "submitting" ? "Signing…" : "Confirm with passkey"}
            </button>
            <button
              onClick={() => setFlow({ step: "form" })}
              disabled={flow.step === "submitting"}
              className="btn btn-dark"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {flow.step === "tracking" && (
        <p className="animate-pulse" style={{ marginTop: 14, fontSize: 14, color: "var(--muted)" }}>
          Confirming on the network…{" "}
          <span className="mono" style={{ wordBreak: "break-all" }}>
            {flow.hash}
          </span>
        </p>
      )}

      {flow.step === "done" && (
        <div
          style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}
        >
          <p style={{ color: flow.result === "success" ? "var(--signal)" : "var(--negative)" }}>
            {flow.result === "success" ? "Payment confirmed." : "Payment failed on the network."}
          </p>
          <p
            className="mono"
            style={{ wordBreak: "break-all", fontSize: 12, color: "var(--muted2)" }}
          >
            {flow.hash}
          </p>
          <button
            onClick={() => setFlow({ step: "form" })}
            className="btn btn-dark btn-sm"
            style={{ alignSelf: "flex-start" }}
          >
            Send another
          </button>
        </div>
      )}

      {error && (
        <p role="alert" style={{ marginTop: 14, fontSize: 14, color: "var(--negative)" }}>
          {error}
        </p>
      )}
    </section>
  );
}
