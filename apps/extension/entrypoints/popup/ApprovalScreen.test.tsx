import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PendingApprovalSummary } from "../../lib/messages";
import {
  ApprovalScreen,
  resolveVerificationTreatment,
  VerificationStateBanner,
} from "./ApprovalScreen";

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: vi.fn(),
    },
  },
}));

const APPROVAL: PendingApprovalSummary = {
  id: "req-1",
  origin: "https://dex.stellar.example",
  request: {
    method: "connect",
    params: { network: "testnet" },
  },
};

const WALLET = {
  address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  network: "testnet" as const,
  rpcUrl: "https://soroban-testnet.stellar.org",
  keyId: "key-1",
  walletWasmHash: "a".repeat(64),
};

describe("ApprovalScreen distinct verification record treatments (#587)", () => {
  it("distinguishes no verification record at all (no_record) from explicitly flagged unverified", () => {
    const noRecord = resolveVerificationTreatment({ status: "unverified" });
    const explicitFailed = resolveVerificationTreatment({
      status: "failed",
      recordId: "rec-failed-1",
      statusDetail: "Build hash mismatch against on-chain WASM.",
    });
    const explicitUnverifiedWithRecord = resolveVerificationTreatment({
      status: "unverified",
      recordId: "rec-flagged-2",
      explicitlyFlagged: true,
    });

    expect(noRecord.variant).toBe("no_record");
    expect(noRecord.calloutTone).toBe("neutral");
    expect(noRecord.badgeLabel).toBe("No verification record");

    expect(explicitFailed.variant).toBe("explicit_unverified");
    expect(explicitFailed.calloutTone).toBe("warn");
    expect(explicitFailed.badgeLabel).toBe("Flagged unverified");
    expect(explicitFailed.description).toContain("Build hash mismatch");

    expect(explicitUnverifiedWithRecord.variant).toBe("explicit_unverified");
    expect(explicitUnverifiedWithRecord.signalClassName).toBe("signal warn");
  });

  it("provides a distinct danger treatment for revoked verification records", () => {
    const revoked = resolveVerificationTreatment({
      status: "revoked",
      recordId: "rec-revoked-1",
      revoked: true,
    });

    expect(revoked.variant).toBe("revoked");
    expect(revoked.calloutTone).toBe("danger");
    expect(revoked.signalClassName).toBe("signal bad");
    expect(revoked.badgeLabel).toBe("Verification revoked");
  });

  it("renders distinct DOM attributes and copy on ApprovalScreen for no_record vs explicit_unverified vs revoked", () => {
    const noRecordHtml = renderToStaticMarkup(
      <ApprovalScreen
        approval={APPROVAL}
        position={1}
        total={1}
        wallet={WALLET}
        verificationRecord={{ status: "unverified" }}
        onResolved={vi.fn()}
      />,
    );

    const flaggedHtml = renderToStaticMarkup(
      <ApprovalScreen
        approval={APPROVAL}
        position={1}
        total={1}
        wallet={WALLET}
        verificationRecord={{
          status: "failed",
          recordId: "rec-99",
          statusDetail: "Hash mismatch detected.",
        }}
        onResolved={vi.fn()}
      />,
    );

    const revokedHtml = renderToStaticMarkup(
      <ApprovalScreen
        approval={APPROVAL}
        position={1}
        total={1}
        wallet={WALLET}
        verificationRecord={{
          status: "revoked",
          revoked: true,
          recordId: "rec-100",
        }}
        onResolved={vi.fn()}
      />,
    );

    expect(noRecordHtml).toContain('data-verification-variant="no_record"');
    expect(noRecordHtml).toContain("No verification record found");
    expect(noRecordHtml).not.toContain("Contract explicitly flagged as unverified");

    expect(flaggedHtml).toContain('data-verification-variant="explicit_unverified"');
    expect(flaggedHtml).toContain("Contract explicitly flagged as unverified");
    expect(flaggedHtml).toContain("Hash mismatch detected.");

    expect(revokedHtml).toContain('data-verification-variant="revoked"');
    expect(revokedHtml).toContain("Contract verification was revoked");
  });

  it("renders verified treatment for verified records", () => {
    const html = renderToStaticMarkup(
      <VerificationStateBanner record={{ status: "verified", recordId: "rec-ok" }} />,
    );
    expect(html).toContain('data-verification-variant="verified"');
    expect(html).toContain("Verified source");
  });
});
