"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useConnectedWallet } from "../../lib/connected-wallet-context";
import { marketplaceApiUrl } from "../../lib/config";
import type { ListingRecord } from "../../lib/marketplace-types";
import { connectedWalletErrorMessage } from "@vellar/provider-sdk/connected-wallet";

// Seller registration form — new-build-technical-doc.md §5.2, §7.2. The
// registration nonce is fetched on mount (step 1 of the flow) so it's ready
// the moment the seller submits; §5.2's 5-minute TTL comfortably covers the
// time spent filling in the form.

interface FormState {
  title: string;
  description: string;
  resourceUrl: string;
  priceAtomic: string;
  asset: string;
  scheme: "exact" | "upto";
}

const EMPTY_FORM: FormState = {
  title: "",
  description: "",
  resourceUrl: "",
  priceAtomic: "",
  asset: "",
  scheme: "exact",
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function ListingForm({
  walletAddress,
  onSuccess,
}: {
  walletAddress: string;
  onSuccess: (listing: ListingRecord) => void;
}) {
  const { signTransaction } = useConnectedWallet();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [nonce, setNonce] = useState<string | null>(null);
  const [nonceError, setNonceError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Step 1 of the nonce flow (§5.2): fetch on mount so it's already in hand
  // by the time the seller finishes the form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${marketplaceApiUrl()}/listings/nonce?address=${encodeURIComponent(walletAddress)}`,
        );
        const body = (await readJson(res)) as { nonce?: string; message?: string };
        if (cancelled) return;
        if (!res.ok || !body.nonce) {
          setNonceError(body.message ?? "Could not get a registration nonce");
          return;
        }
        setNonce(body.nonce);
      } catch (err) {
        if (!cancelled) {
          setNonceError(err instanceof Error ? err.message : "Could not reach the marketplace");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!nonce) {
      setSubmitError("No registration nonce available yet — try again in a moment.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      // TODO(step-4): PLACEHOLDER signature. The real flow builds a Stellar
      // transaction with a single ManageData("vellar-register", nonce)
      // operation (new-build-technical-doc.md §5.2 step 2) and signs THAT —
      // it requires @stellar/stellar-sdk's TransactionBuilder client-side,
      // which is deferred to the follow-on step so this one can verify the
      // nonce-fetch → form → submit UI flow end to end first. The backend's
      // verifyRegistrationSignature will correctly reject this placeholder;
      // expect 400/401 here until step 4 replaces it.
      const signedXdr = await signTransaction("placeholder");
      const res = await fetch(`${marketplaceApiUrl()}/listings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceUrl: form.resourceUrl,
          title: form.title,
          description: form.description || undefined,
          priceAtomic: form.priceAtomic,
          asset: form.asset,
          scheme: form.scheme,
          signedXdr,
          walletAddress,
        }),
      });
      const body = (await readJson(res)) as { listing?: ListingRecord; message?: string };
      if (!res.ok || !body.listing) {
        setSubmitError(body.message ?? "Could not create the listing");
        return;
      }
      onSuccess(body.listing);
    } catch (err) {
      setSubmitError(connectedWalletErrorMessage(err, "Could not create the listing"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="lp-mkt-form" onSubmit={(e) => void handleSubmit(e)}>
      {nonceError && (
        <div className="lp-mkt-error" role="alert">
          <div>
            <strong>Setup failed</strong>
            <p>{nonceError}</p>
          </div>
        </div>
      )}

      <div className="lp-mkt-field">
        <label htmlFor="listing-title">Title</label>
        <input
          id="listing-title"
          type="text"
          required
          value={form.title}
          onChange={(e) => update("title", e.target.value)}
        />
      </div>

      <div className="lp-mkt-field">
        <label htmlFor="listing-description">Description</label>
        <textarea
          id="listing-description"
          value={form.description}
          onChange={(e) => update("description", e.target.value)}
        />
      </div>

      <div className="lp-mkt-field">
        <label htmlFor="listing-resource-url">Resource URL</label>
        <input
          id="listing-resource-url"
          type="url"
          required
          value={form.resourceUrl}
          onChange={(e) => update("resourceUrl", e.target.value)}
        />
        <span className="field-hint">The URL that returns 402 Payment Required</span>
      </div>

      <div className="lp-mkt-field">
        <label htmlFor="listing-price">Price (base units)</label>
        <input
          id="listing-price"
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          required
          value={form.priceAtomic}
          onChange={(e) => update("priceAtomic", e.target.value)}
        />
        <span className="field-hint">Price in base units (1 USDC = 10,000,000)</span>
      </div>

      <div className="lp-mkt-field">
        <label htmlFor="listing-asset">Asset</label>
        <input
          id="listing-asset"
          type="text"
          required
          value={form.asset}
          onChange={(e) => update("asset", e.target.value)}
        />
        <span className="field-hint">Asset contract ID</span>
      </div>

      <div className="lp-mkt-field">
        <label htmlFor="listing-scheme">Scheme</label>
        <select
          id="listing-scheme"
          value={form.scheme}
          onChange={(e) => update("scheme", e.target.value as FormState["scheme"])}
        >
          <option value="exact">exact</option>
          <option value="upto">upto</option>
        </select>
      </div>

      {submitError && (
        <div className="lp-mkt-error" role="alert">
          <div>
            <strong>Could not list this service</strong>
            <p>{submitError}</p>
          </div>
        </div>
      )}

      <div className="lp-cta-row">
        <button type="submit" disabled={submitting} className="lp-btn lp-btn--sun">
          {submitting ? "Listing..." : "List service"}
        </button>
      </div>
    </form>
  );
}
