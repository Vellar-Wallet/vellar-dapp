"use client";

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { WalletRequired } from "../../../../components/marketplace/WalletRequired";
import { useConnectedWallet } from "../../../../lib/connected-wallet-context";
import { marketplaceApiUrl } from "../../../../lib/config";
import { formatPriceAtomic, type ListingRecord } from "../../../../lib/marketplace-types";
import { connectedWalletErrorMessage } from "@vellar/provider-sdk/connected-wallet";
import "../../../landing/landing.css";

// Listing detail / basic edit — new-build-technical-doc.md §7.3. Client
// component: ownership (does the connected address match the seller?) can
// only be checked client-side, and the edit form needs signTransaction.
// Full edit (price/scheme/status) is a follow-on; this covers title and
// description only, per the Step 3 scope.

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function EditForm({
  listing,
  walletAddress,
  onUpdated,
}: {
  listing: ListingRecord;
  walletAddress: string;
  onUpdated: (listing: ListingRecord) => void;
}) {
  const { signTransaction } = useConnectedWallet();
  const [title, setTitle] = useState(listing.title);
  const [description, setDescription] = useState(listing.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // TODO(step-4): PLACEHOLDER signature — see ListingForm.tsx and
      // PayButton.tsx for the same note. Real transaction construction is
      // deferred to the follow-on step; this verifies the edit UI flow.
      const signedXdr = await signTransaction("placeholder");
      const res = await fetch(`${marketplaceApiUrl()}/listings/${listing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, description, signedXdr, walletAddress }),
      });
      const body = (await readJson(res)) as { listing?: ListingRecord; message?: string };
      if (!res.ok || !body.listing) {
        setError(body.message ?? "Could not update the listing");
        return;
      }
      onUpdated(body.listing);
    } catch (err) {
      setError(connectedWalletErrorMessage(err, "Could not update the listing"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="lp-mkt-form" onSubmit={(e) => void handleSubmit(e)}>
      <div className="lp-mkt-field">
        <label htmlFor="edit-title">Title</label>
        <input id="edit-title" type="text" required value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="lp-mkt-field">
        <label htmlFor="edit-description">Description</label>
        <textarea id="edit-description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {error && (
        <div className="lp-mkt-error" role="alert">
          <div>
            <strong>Could not save</strong>
            <p>{error}</p>
          </div>
        </div>
      )}
      <div className="lp-cta-row">
        <button type="submit" disabled={saving} className="lp-btn lp-btn--sun lp-btn--sm">
          {saving ? "Saving..." : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function ListingDetail({ id, address }: { id: string; address: string }) {
  const [listing, setListing] = useState<ListingRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${marketplaceApiUrl()}/listings/${id}`);
        const body = (await readJson(res)) as { listing?: ListingRecord; message?: string };
        if (cancelled) return;
        if (!res.ok || !body.listing) {
          setLoadError(body.message ?? "Listing not found");
          return;
        }
        setListing(body.listing);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not reach the marketplace");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loadError) {
    return (
      <div className="lp-mkt-error" role="alert">
        <div>
          <strong>Could not load this listing</strong>
          <p>{loadError}</p>
        </div>
      </div>
    );
  }

  if (!listing) {
    return <div className="lp-mkt-skeleton lp-mkt-skeleton-card" />;
  }

  const isOwner = listing.sellerAddress === address;

  return (
    <>
      <div className="lp-sechead" data-reveal>
        <div>
          <span className="lp-eyebrow">Seller Portal</span>
          <h1>{listing.title}</h1>
        </div>
      </div>

      <div className="lp-mkt-card lp-mkt-card--mint">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <h3 className="mkt-title">{listing.title}</h3>
          <span className="lp-badge">{listing.status}</span>
        </div>
        <p className="mkt-desc">{listing.description || "No description provided."}</p>
        <div className="mkt-foot">
          <span className="mkt-price">{formatPriceAtomic(listing.priceAtomic)} USDC</span>
          <span className="mkt-meta">{listing.resourceUrl}</span>
        </div>
      </div>

      <section className="lp-sec lp-sec--tight">
        <div className="lp-rlist">
          <div className="lp-rrow">
            <div className="rn">
              <b>Total settlements</b>
              <span>Payments received</span>
            </div>
            <span className="open">{listing.totalSettlements}</span>
          </div>
          <div className="lp-rrow">
            <div className="rn">
              <b>Total revenue</b>
              <span>Cumulative earnings</span>
            </div>
            <span className="open">{formatPriceAtomic(listing.totalRevenue)} USDC</span>
          </div>
          <div className="lp-rrow">
            <div className="rn">
              <b>First settled</b>
              <span>When this listing went active</span>
            </div>
            <span className="open">{listing.firstSettledAt ?? "Not yet active"}</span>
          </div>
        </div>
      </section>

      {isOwner ? (
        <section className="lp-sec lp-sec--tight">
          <EditForm listing={listing} walletAddress={address} onUpdated={setListing} />
        </section>
      ) : (
        <div className="lp-mkt-error" role="alert">
          <div>
            <strong>Read-only</strong>
            <p>Only the seller who registered this listing can edit it.</p>
          </div>
        </div>
      )}
    </>
  );
}

export default function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { isConnected, address } = useConnectedWallet();

  return (
    <main className="lp">
      <div className="lp-wrap">
        <Link href="/sell" className="lp-btn lp-btn--ghost">
          ← Back to listings
        </Link>
        <div style={{ marginTop: "var(--lp-sp-6)" }}>
          <WalletRequired message="Connect your wallet to manage this listing">
            {isConnected && address && <ListingDetail id={id} address={address} />}
          </WalletRequired>
        </div>
      </div>
    </main>
  );
}
