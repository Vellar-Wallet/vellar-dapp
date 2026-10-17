import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionState } from "../../lib/state";
import { HomeScreen, PairedOriginsEmptyState } from "./HomeScreen";

const PAIRED_WALLET = {
  address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  network: "testnet" as const,
  rpcUrl: "https://soroban-testnet.stellar.org",
  keyId: "key-1",
  walletWasmHash: "a".repeat(64),
  webAppOrigin: "https://app.vellar.xyz",
};

describe("HomeScreen paired origins empty state (#588)", () => {
  it("renders the explicit empty state and CTA when zero origins are paired", () => {
    const state: ExtensionState = {
      pairedWallet: PAIRED_WALLET,
      grants: [],
    };

    const html = renderToStaticMarkup(<HomeScreen state={state} onRevoke={vi.fn()} />);

    expect(html).toContain('data-testid="paired-origins-empty-state"');
    expect(html).toContain("No paired origins yet");
    expect(html).toContain("Open a supported Stellar dApp in your browser");
    expect(html).toContain("Click Connect Wallet and choose Vellar");
    expect(html).toContain("Approve the origin pairing request in this popup");
    expect(html).toContain('data-testid="paired-origins-cta"');
    expect(html).toContain("Open Vellar app to pair a dApp");
    expect(html).not.toContain('data-testid="paired-origin-row"');
  });

  it("renders fallback CTA guidance when webAppOrigin is not set on the paired wallet", () => {
    const html = renderToStaticMarkup(<PairedOriginsEmptyState />);

    expect(html).toContain('data-testid="paired-origins-empty-state"');
    expect(html).toContain('data-testid="paired-origins-cta"');
    expect(html).toContain(
      "Visit any Stellar dApp and select Connect Wallet to pair your first origin.",
    );
  });

  it("hides the empty state immediately when one or more origins are paired", () => {
    const state: ExtensionState = {
      pairedWallet: PAIRED_WALLET,
      grants: [
        {
          origin: "https://dex.stellar.example",
          accountId: PAIRED_WALLET.address,
          network: "testnet",
          capabilities: ["connect", "view_address", "sign"],
          grantedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    const html = renderToStaticMarkup(<HomeScreen state={state} onRevoke={vi.fn()} />);

    expect(html).not.toContain('data-testid="paired-origins-empty-state"');
    expect(html).toContain('data-testid="paired-origin-row"');
    expect(html).toContain("dex.stellar.example");
    expect(html).toContain('<span class="count">1</span>');
  });

  it("renders the unpaired wallet state when no wallet has been paired yet", () => {
    const html = renderToStaticMarkup(<HomeScreen state={null} onRevoke={vi.fn()} />);

    expect(html).toContain('data-testid="unpaired-wallet-empty-state"');
    expect(html).toContain("Connect your wallet");
  });
});
