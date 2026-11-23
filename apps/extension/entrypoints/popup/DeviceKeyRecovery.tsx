import type { DeviceKeyStatus } from "../../lib/device-key";
import type { PairedWallet } from "../../lib/state";

// Device-key recovery screen (#581): a wallet is paired, but the local
// signing key failed to load or doesn't look valid. This is distinct from
// the first-run "not paired yet" state (HomeScreen's Unpaired) — the wallet
// IS paired, so the fix is re-pairing the device key, not starting over.

const COPY: Record<"load_failed" | "invalid" | "wallet_mismatch", { title: string; body: string }> =
  {
    load_failed: {
      title: "Can't load your signing key",
      body:
        "This device's local signing key couldn't be read from storage. This can happen if " +
        "browser storage was cleared, ran out of space, or became corrupted. Your wallet itself " +
        "is safe — only this browser's local signer needs to be re-paired.",
    },
    invalid: {
      title: "Signing key needs attention",
      body:
        "This device's local signing key was found but doesn't look valid. Re-pair this " +
        "extension to generate a fresh signing key for this device.",
    },
    wallet_mismatch: {
      title: "Signing key belongs to another wallet",
      body:
        "This device still has a signing key from a previous pairing. It cannot be used for " +
        "the wallet now paired, so re-pair this extension to generate a fresh signing key. " +
        "Your wallet itself is safe.",
    },
  };

export function DeviceKeyRecovery({
  status,
  wallet,
}: {
  status: DeviceKeyStatus;
  wallet: PairedWallet | undefined;
}) {
  // App.tsx only renders this for load_failed, invalid or wallet_mismatch, but
  // the prop type is the full status union, so fall back to the generic copy.
  const copy = COPY[status === "invalid" || status === "wallet_mismatch" ? status : "load_failed"];
  const app = wallet?.webAppOrigin;

  return (
    <main className="frame" aria-label={copy.title}>
      <header className="frame-head">
        <img className="brand" src="/logo-mark.png" alt="Vellar" />
      </header>
      <div className="frame-body">
        <section className="unpaired">
          <span className="eyebrow">Action needed</span>
          <h1>{copy.title}</h1>
          <p>{copy.body}</p>
          <ol className="steps">
            <li>Open the Vellar web app and sign in</li>
            <li>Go to Settings → Pair extension</li>
            <li>Confirm with your passkey to re-pair this device</li>
          </ol>
        </section>
      </div>
      {app && (
        <footer className="frame-foot">
          <div className="btn-row">
            <button
              className="btn btn-sun"
              onClick={() => window.open(`${app}/settings`, "_blank", "noreferrer")}
            >
              Open Vellar app
            </button>
          </div>
        </footer>
      )}
    </main>
  );
}
