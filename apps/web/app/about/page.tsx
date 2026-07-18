import Link from "next/link";
import type { Metadata } from "next";
import { LandingNav } from "../landing/nav";
import { PersonaImage } from "./persona-image";

export const metadata: Metadata = {
  title: "About — Vellar",
  description:
    "About Vellar — the passkey-powered smart wallet for Stellar, and the person building it.",
};

export default function About() {
  return (
    <div className="landing-root">
      <LandingNav />

      <main className="about">
        <div className="wrap">
          {/* Intro */}
          <section className="about-hero">
            <span className="eyebrow">About</span>
            <h1>Passkeys, not seed phrases.</h1>
            <p>
              Vellar is a self-custodial smart wallet for Stellar. You sign in with a passkey — Face
              ID, Touch ID or a security key — instead of memorizing a seed phrase, and your account
              is a smart contract that can enforce real, on-chain rules: spending limits,
              co-signers, allow-lists. No custody, no compromises.
            </p>
            <p>
              It&apos;s web-first, with a companion browser extension for connecting to Stellar
              dApps, and a developer SDK so any builder can add the same passkey wallet to their own
              app. Everything is designed so the secure default is the only default — no silent
              signing, no key custody, fees sponsored so you never need to hold XLM just to
              transact.
            </p>
          </section>

          {/* Persona */}
          <section className="about-persona">
            {/* Upload your photo to apps/web/public/persona.jpg to replace the
                initials placeholder below. */}
            <div className="persona-photo">
              <PersonaImage />
            </div>
            <div className="persona-body">
              <span className="eyebrow">Who&apos;s building it</span>
              <h2>David Ejere</h2>
              <p className="persona-role mono">Founder &amp; builder</p>
              <p>
                I&apos;m building Vellar to make Stellar wallets something people can actually use
                without fear — no seed phrases to lose, no blind signing, and security that the
                network enforces rather than a promise in the UI. Vellar started as a wallet and is
                growing into the tooling other Stellar developers can build on.
              </p>
              <div className="persona-links">
                <a
                  href="https://github.com/Vellar-Wallet"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
                <a href="mailto:hello@vellar.xyz">hello@vellar.xyz</a>
              </div>
            </div>
          </section>

          <div className="about-back">
            <Link href="/" className="btn btn-glass">
              ← Back to Vellar
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
