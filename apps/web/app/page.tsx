import Link from "next/link";
import { LandingNav } from "./landing/nav";
import { EverydaySection } from "./landing/rail";
import { Waves } from "./landing/waves";

// Marketing landing (reference build: landing-page/VELA Landing.html; rules
// in design.md). The wallet app lives at /app.

const features = [
  {
    title: "Instant DEX swaps",
    body: "Trade Stellar assets natively without leaving your wallet — settled on-chain in seconds.",
    icon: <path d="M7 8h10M7 8l3-3M17 16H7m10 0l-3 3" />,
  },
  {
    title: "Programmable policies",
    body: "Spending limits, co-signers, time locks and allow-lists — enforced by the network, not a promise.",
    icon: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />,
  },
  {
    title: "Contract verification",
    body: "See exactly what a contract does before you sign. VELA flags what's verified and what's risky.",
    icon: (
      <>
        <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" />
        <path d="M9 12l2 2 4-4" />
      </>
    ),
  },
  {
    title: "Biometric login",
    body: "Unlock with Face ID, Touch ID or a security key. Keys live in your device's secure enclave.",
    icon: <path d="M9 11a4 4 0 118 0c0 3-3 4-3 4M13 20h.01M12 3a9 9 0 100 18" />,
  },
  {
    title: "Zero seed phrases",
    body: "Nothing to write down, nothing to leak. Register multiple passkeys across your devices.",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.7 2.5 1.7c0 2-5 1.3-5 3.3 0 1 1 1.7 2.5 1.7s2.5-.5 2.5-1.5" />
      </>
    ),
  },
  {
    title: "Safe account cleanup",
    body: "Reclaim locked reserves from unused trustlines and stale entries in one guided sweep.",
    icon: (
      <>
        <path d="M4 7l8-4 8 4-8 4-8-4z" />
        <path d="M4 12l8 4 8-4M4 17l8 4 8-4" />
      </>
    ),
  },
  {
    title: "Non-custodial",
    body: "Your account and keys live on Stellar and in your enclave. We never touch your funds.",
    icon: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M3 10h18" />
      </>
    ),
  },
  {
    title: "Trust signals",
    body: "Every signature comes with a plain-language breakdown and a risk score before you approve.",
    icon: (
      <>
        <rect x="4" y="4" width="7" height="7" rx="2" />
        <rect x="13" y="4" width="7" height="7" rx="2" />
        <rect x="4" y="13" width="7" height="7" rx="2" />
        <rect x="13" y="13" width="7" height="7" rx="2" />
      </>
    ),
  },
  {
    title: "Developer SDK",
    body: "Ship passkey auth, policies and contract-verification tooling into your own Stellar app.",
    icon: <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12" />,
  },
];

const faqs = [
  {
    q: "Is VELA custodial?",
    a: "No. VELA is fully self-custodial — your account and keys live on Stellar and in your device's secure enclave. We never hold your funds or your passkeys.",
    open: true,
  },
  {
    q: "What happens if I lose my device?",
    a: "Register multiple passkeys across devices, and use account policies to add recovery co-signers. Losing one device doesn't lock you out — that's the whole point of moving past single seed phrases.",
  },
  {
    q: "Do I need the browser extension?",
    a: "Not to get started — VELA is web-first. The extension is there when you want one-click connections to Stellar dApps with the same passkey and policies you've already set.",
  },
  {
    q: "What are programmable policies, exactly?",
    a: "On-chain rules enforced by the network: spending limits, required co-signers, time locks and allow-lists. They apply to every transaction automatically, so a compromised session still can't drain the account.",
  },
  {
    q: "Is it ready for teams and developers?",
    a: "Yes. Teams get multi-signer policies and shared controls; developers get an SDK, contract-verification tooling and the extension's connect API.",
  },
];

export default function Landing() {
  return (
    <div className="landing-root">
      <LandingNav />
      <span id="top" />

      {/* HERO */}
      <header className="hero">
        <div className="aurora">
          <Waves />
          <div className="blob3"></div>
        </div>
        <div className="hero-inner wrap">
          <span className="eyebrow">
            <span className="pulse"></span> Stellar testnet · live
          </span>
          <h1>
            Your Stellar wallet.
            <br />
            Secured by <span className="g">passkeys</span>, not seed phrases.
          </h1>
          <p className="hero-sub">
            VELA is the passkey-powered smart wallet for Stellar — programmable security, contract
            verification, and trust signals on every transaction. Web-first, with a companion
            browser extension.
          </p>
          <div className="hero-cta">
            <Link href="/app" className="btn btn-signal btn-lg">
              Launch web app →
            </Link>
            <a href="#platforms" className="btn btn-dark btn-lg">
              Get the extension
            </a>
          </div>
        </div>

        {/* overlapping product UI */}
        <div className="stage">
          <div className="stage-mask">
            <div className="pcard swap">
              <div className="pc-top">
                <span>← Swap</span>
                <span className="pc-dot">⇄</span>
              </div>
              <div className="field">
                <div className="lbl">YOU SELL</div>
                <div className="row">
                  <span className="amt">0</span>
                  <span className="token">
                    <i></i>XLM ▾
                  </span>
                </div>
                <div className="sub">
                  <span>$0.00</span>
                  <span>1691.69 XLM</span>
                </div>
              </div>
              <div className="field">
                <div className="lbl">YOU RECEIVE</div>
                <div className="row">
                  <span className="amt">0</span>
                  <span className="token usdc">
                    <i></i>USDC ▾
                  </span>
                </div>
                <div className="sub">
                  <span>$0.00</span>
                  <span>500.00 USDC</span>
                </div>
              </div>
              <div className="chips">
                <b>25%</b>
                <b>50%</b>
                <b className="on">75%</b>
                <b>Max</b>
              </div>
            </div>

            <div className="pcard dash">
              <div className="pc-top">
                <span className="pc-dot">⋯</span>
                <span className="pc-dot">⧉</span>
              </div>
              <div className="acct">Account 1 ▾</div>
              <div className="bal">$1,305.13</div>
              <div className="actions" style={{ marginBottom: 20 }}>
                <div className="a">
                  <i>+</i>Add
                </div>
                <div className="a">
                  <i>↑</i>Send
                </div>
                <div className="a">
                  <i>⇄</i>Swap
                </div>
                <div className="a">
                  <i>⧉</i>Copy
                </div>
              </div>
              <div className="tabs" style={{ marginBottom: 4 }}>
                <span>Tokens</span>
                <span className="off">Policies</span>
              </div>
              <div className="tokrow">
                <div className="ti"></div>
                <div className="tn">
                  <b>Stellar Lumens</b>
                  <span>1691.69 XLM</span>
                </div>
                <div className="tv">
                  <b>$654.68</b>
                  <span>+3.14%</span>
                </div>
              </div>
              <div className="tokrow usdc">
                <div className="ti"></div>
                <div className="tn">
                  <b>USD Coin</b>
                  <span>345.34 USDC</span>
                </div>
                <div className="tv">
                  <b>$345.34</b>
                  <span>+0.00%</span>
                </div>
              </div>
            </div>

            <div className="pcard trend">
              <div className="pc-top">
                <span>Trust center</span>
                <span className="pc-dot">◇</span>
              </div>
              <div className="promo">
                <div className="pv"></div>
                <span className="verified">✓ Contract verified</span>
                <div>
                  <b>Blend · Lending</b>
                  <div className="pt">POLICY: SPEND LIMIT OK</div>
                </div>
              </div>
              <div className="rlist">
                <div className="rrow">
                  <div className="ri"></div>
                  <div className="rn">
                    <b>Allbridge</b>
                    <span>Bridge · verified</span>
                  </div>
                  <span className="open">Open</span>
                </div>
                <div className="rrow">
                  <div className="ri"></div>
                  <div className="rn">
                    <b>Lumenswap</b>
                    <span>Exchange · verified</span>
                  </div>
                  <span className="open">Open</span>
                </div>
                <div className="rrow">
                  <div className="ri"></div>
                  <div className="rn">
                    <b>Litemint</b>
                    <span>Collectibles</span>
                  </div>
                  <span className="open">Open</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <EverydaySection />

      {/* PLATFORM CARDS */}
      <section className="sec" id="platforms" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="plat">
            <div className="platcard">
              <div className="pglow"></div>
              <h3>Web-first</h3>
              <p>
                Create and use your smart wallet straight from the browser — no download, no seed
                phrase. Just a passkey.
              </p>
              <div className="pfoot">
                <Link href="/app" className="btn btn-glass">
                  Launch web app
                </Link>
              </div>
              <div className="mini">
                <div className="miniui">
                  <div className="mr">
                    <span>You are sending</span>
                    <b>166.6 XLM</b>
                  </div>
                  <div className="mr">
                    <span>Fee</span>
                    <b>Sponsored</b>
                  </div>
                  <div className="mr">
                    <span>Policy</span>
                    <b style={{ color: "var(--signal)" }}>✓ OK</b>
                  </div>
                  <div className="mr">
                    <span>Signed with</span>
                    <b>Passkey</b>
                  </div>
                </div>
              </div>
            </div>
            <div
              className="platcard"
              style={{
                background: "linear-gradient(135deg,#0f3d33,var(--green-mid) 60%,var(--green))",
              }}
            >
              <div className="pglow" style={{ background: "var(--signal)" }}></div>
              <h3>Browser extension</h3>
              <p>
                Bring VELA to any Stellar dApp — same passkey, same on-chain policies, one click to
                connect.
              </p>
              <div className="pfoot">
                <a href="#faq" className="btn btn-glass">
                  Get the extension
                </a>
              </div>
              <div className="mini">
                <div className="miniui">
                  <div className="mr">
                    <span>Stellar Lumens</span>
                    <b>2500.00</b>
                  </div>
                  <div className="mr">
                    <span>USD Coin</span>
                    <b>100.00</b>
                  </div>
                  <div className="mr">
                    <span>EUROC</span>
                    <b>100.00</b>
                  </div>
                  <div className="mr">
                    <span>Connect</span>
                    <b style={{ color: "var(--signal)" }}>✓ Verified</b>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURE GRID */}
      <section className="sec" id="features">
        <div className="wrap">
          <div className="sec-head" style={{ marginBottom: 36 }}>
            <div>
              <span className="eyebrow">What you get</span>
              <h2>Security that runs on-chain.</h2>
            </div>
            <p>
              Everything is self-custodial and yours. VELA layers modern auth and programmable
              guardrails over your Stellar account — no custody, no compromises.
            </p>
          </div>
          <div className="fgrid">
            {features.map((f) => (
              <div className="fcell" key={f.title}>
                <div className="ico">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    {f.icon}
                  </svg>
                </div>
                <h4>{f.title}</h4>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="sec" id="faq">
        <div className="wrap faq-grid">
          <div>
            <span className="eyebrow" style={{ display: "block", marginBottom: 16 }}>
              Questions
            </span>
            <h2>Frequently asked questions</h2>
            <p style={{ color: "var(--muted)", marginTop: 16, fontSize: 15, lineHeight: 1.6 }}>
              Still curious? Reach us at <a href="mailto:hey@vela.xyz">hey@vela.xyz</a> or read the
              developer docs.
            </p>
          </div>
          <div>
            {faqs.map((f) => (
              <details className="fitem" key={f.q} open={f.open}>
                <summary>
                  {f.q} <span className="pm">+</span>
                </summary>
                <div className="fbody">{f.a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="wrap" id="cta">
        <div className="cta">
          <div className="g1"></div>
          <div className="g2"></div>
          <h2 className="cta-try">
            <span>Try</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-light.png" alt="VELA" className="cta-try-logo" />
            <span>today</span>
          </h2>
          <p>Self-custodial and passkey-secured. Spin up a smart wallet in seconds.</p>
          <div className="hero-cta">
            <Link href="/app" className="btn btn-glass btn-lg">
              Launch web app
            </Link>
            <a href="#platforms" className="btn btn-glass btn-lg">
              Get extension
            </a>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="site">
        <div className="wrap">
          <div className="foot-top">
            <div className="foot-brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-light.png" alt="VELA" />
              <p>
                The passkey-powered smart wallet for Stellar. Programmable security and trust
                signals for everyday users, developers and teams.
              </p>
            </div>
            <div className="foot-cols">
              <div className="foot-col">
                <h4>Product</h4>
                <a href="#features">Features</a>
                <a href="#wallet">Wallet</a>
                <a href="#platforms">Extension</a>
                <a href="#faq">FAQ</a>
              </div>
              <div className="foot-col">
                <h4>Developers</h4>
                <a href="/docs">Documentation</a>
                <a href="/docs/architecture">Architecture</a>
                <a href="/docs/api-reference">API reference</a>
                <a href="/docs/security-model">Security model</a>
              </div>
              <div className="foot-col">
                <h4>Company</h4>
                <a href="#">About</a>
                <a href="#">Security</a>
                <a href="mailto:hey@vela.xyz">Contact</a>
              </div>
            </div>
          </div>
          <div className="foot-bot">
            <span>© 2026 VELA · Built on Stellar</span>
            <span className="mono">passkeys · policies · trust</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
