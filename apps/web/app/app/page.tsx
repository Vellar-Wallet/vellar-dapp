import Link from "next/link";
import { OnboardingActions } from "../onboarding-actions";

// Wallet entry (/app): passkey onboarding (technical-doc.md §7.1). The
// marketing landing lives at /.

export default function AppEntry() {
  return (
    <main className="wrap" style={{ paddingTop: 120, paddingBottom: 96 }}>
      <Link href="/" className="mono" style={{ fontSize: 12, color: "var(--muted2)" }}>
        ← vela.xyz
      </Link>
      <div style={{ maxWidth: 560, margin: "48px auto 0", textAlign: "center" }}>
        <span className="eyebrow">
          <span className="pulse" style={{ display: "inline-block", marginRight: 8 }}></span>
          Wallet · testnet
        </span>
        <h1 style={{ fontSize: "clamp(2.2rem,5vw,3.4rem)", marginTop: 20 }}>
          Step into your wallet.
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 16, fontSize: 16, lineHeight: 1.6 }}>
          Create a smart account with a passkey, or sign back in with the one you already have. No
          seed phrase, no password — just you.
        </p>
      </div>
      <div className="card" style={{ maxWidth: 480, margin: "36px auto 0" }}>
        <OnboardingActions />
      </div>
    </main>
  );
}
