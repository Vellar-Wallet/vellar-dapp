"use client";

import { useEffect, useState } from "react";
import { TrustBadge } from "@vellar/ui";
import { AppShell } from "@/components/app-shell";
import { Eyebrow, LpActionButton, LpButton } from "@/app/landing/ui";
import { SendPayment } from "@/app/dashboard/send-payment";
import { walletConfig } from "@/lib/config";
import {
  parsePayUri,
  verifySep7Origin,
  type OriginVerification,
  type Sep7PayRequest,
} from "@/lib/sep7";
import { getVerificationStatus, type VerificationStatusResult } from "@/lib/verification";
import { useWalletSession } from "@/lib/wallet-context";

// Incoming SEP-7 payment requests (issue #402). Reached from a
// web+stellar:pay link (registered protocol handler: /pay?uri=%s) or by
// pasting a request. The URI is untrusted: it is parsed deny-by-default,
// its claimed origin is verified per SEP-7, and a valid request only
// PREFILLS the normal send flow — review + passkey confirmation still gate
// every payment. Nothing here signs or submits.

const KEY_CACHE = "vellar.sep7.signingKeys";

const keyCache = {
  get(domain: string): string | null {
    try {
      const map = JSON.parse(localStorage.getItem(KEY_CACHE) ?? "{}") as Record<string, string>;
      return typeof map[domain] === "string" ? map[domain] : null;
    } catch {
      return null;
    }
  },
  set(domain: string, key: string) {
    try {
      const map = JSON.parse(localStorage.getItem(KEY_CACHE) ?? "{}") as Record<string, string>;
      map[domain] = key;
      localStorage.setItem(KEY_CACHE, JSON.stringify(map));
    } catch {
      /* verification still happened; only change-detection is lost */
    }
  },
};

type Intake =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "rejected"; error: string }
  | { state: "verifying"; request: Sep7PayRequest }
  | { state: "ready"; request: Sep7PayRequest; origin: OriginVerification };

type ContractTrust = VerificationStatusResult | "loading" | "error" | null;

/** Maps the lookup state to TrustBadge's status prop (issue #703). */
function trustBadgeStatus(trust: ContractTrust): "loading" | "error" | VerificationStatusResult["status"] {
  if (trust === null) return "loading";
  if (trust === "loading" || trust === "error") return trust;
  return trust.status;
}

export default function PayPage() {
  const session = useWalletSession();
  const [raw, setRaw] = useState<string | null | undefined>(undefined);
  const [intake, setIntake] = useState<Intake>({ state: "loading" });
  const [pasted, setPasted] = useState("");
  // #703: when the request's destination is a contract, surface the same
  // trust-signal pattern used in verify/page.tsx and the extension approval
  // screen before the user reaches the approval step, not a generic error.
  const [contractTrust, setContractTrust] = useState<ContractTrust>(null);

  useEffect(() => {
    setRaw(new URLSearchParams(window.location.search).get("uri"));
  }, []);

  useEffect(() => {
    if (raw === undefined || !session) return;
    if (raw === null || raw.trim() === "") {
      setIntake({ state: "empty" });
      return;
    }
    const parsed = parsePayUri(raw, {
      network: session.network,
      networkPassphrase: walletConfig().networkPassphrase,
    });
    if (!parsed.ok) {
      setIntake({ state: "rejected", error: parsed.error });
      return;
    }
    const request = parsed.request;
    setIntake({ state: "verifying", request });
    let cancelled = false;
    void verifySep7Origin(request, {
      fetch: (url) => fetch(url, { credentials: "omit" }),
      keyCache,
    }).then((origin) => {
      if (cancelled) return;
      if (origin.status === "invalid") {
        setIntake({ state: "rejected", error: `Can't pay this request: ${origin.reason}` });
      } else {
        setIntake({ state: "ready", request, origin });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [raw, session]);

  useEffect(() => {
    if (intake.state !== "ready" || intake.request.destinationKind !== "contract") {
      setContractTrust(null);
      return;
    }
    const contractId = intake.request.destination;
    let cancelled = false;
    setContractTrust("loading");
    void getVerificationStatus(contractId)
      .then((status) => {
        if (!cancelled) setContractTrust(status);
      })
      .catch(() => {
        if (!cancelled) setContractTrust("error");
      });
    return () => {
      cancelled = true;
    };
  }, [intake]);

  return (
    <AppShell>
      <div className="max-w-[460px]">
        {intake.state === "loading" && (
          <p className="animate-pulse text-sm text-[var(--lp-ink-faint)]">Loading…</p>
        )}

        {intake.state === "empty" && (
          <section className="lpa-panel flex flex-col gap-3">
            <Eyebrow>Pay a request</Eyebrow>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setRaw(pasted);
              }}
            >
              <label className="lpa-field">
                <span className="flabel">Payment request (web+stellar:pay…)</span>
                <textarea
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  rows={4}
                  spellCheck={false}
                />
              </label>
              <LpActionButton type="submit" className="self-start" disabled={!pasted.trim()}>
                Open request
              </LpActionButton>
            </form>
            <LpActionButton
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                try {
                  navigator.registerProtocolHandler(
                    "web+stellar",
                    `${window.location.origin}/pay?uri=%s`,
                  );
                } catch {
                  /* unsupported browser / context — pasting still works */
                }
              }}
            >
              Open web+stellar links with Vellar
            </LpActionButton>
          </section>
        )}

        {intake.state === "rejected" && (
          <section className="lpa-panel flex flex-col gap-3">
            <Eyebrow>Payment request rejected</Eyebrow>
            <p role="alert" className="lpa-bad text-sm">
              {intake.error}
            </p>
            <p className="text-[13px] text-[var(--lp-ink-soft)]">
              Nothing was signed or sent. Ask the requester for a new link.
            </p>
            <LpButton href="/dashboard" variant="outline" size="sm" className="self-start">
              Back to wallet
            </LpButton>
          </section>
        )}

        {intake.state === "verifying" && (
          <p className="animate-pulse text-sm text-[var(--lp-ink-faint)]">
            Checking the request&apos;s origin…
          </p>
        )}

        {intake.state === "ready" && session && (
          <div className="flex flex-col gap-3">
            {intake.request.destinationKind === "contract" && (
              <section
                className="lpa-panel flex items-center gap-2.5"
                aria-label="Contract verification status"
              >
                <TrustBadge status={trustBadgeStatus(contractTrust)} />
                {contractTrust !== null &&
                  contractTrust !== "loading" &&
                  contractTrust !== "error" &&
                  contractTrust.status !== "verified" && (
                    <p role="alert" className="lpa-bad text-sm">
                      This payment request targets a contract with no verified source. Review
                      carefully before approving.
                    </p>
                  )}
              </section>
            )}
            <SendPayment
              from={session.accountId}
              token={intake.request.asset}
              network={session.network}
              onSuccess={() => undefined}
              prefill={{
                to: intake.request.destination,
                ...(intake.request.amount !== undefined && { amount: intake.request.amount }),
              }}
              request={{
                originDomain: intake.origin.status === "verified" ? intake.origin.domain : null,
                ...(intake.request.msg !== undefined && { msg: intake.request.msg }),
              }}
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}
