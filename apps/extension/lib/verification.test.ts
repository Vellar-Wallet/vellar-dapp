import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: vi.fn(),
    },
  },
}));

import {
  extractApprovalContractIds,
  fetchApprovalTrustSignal,
  resolveApprovalTrustSignal,
} from "./verification";
import { ApprovalScreen } from "../entrypoints/popup/ApprovalScreen";

const CONTRACT_VERIFIED = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CONTRACT_NO_RECORD = "CB7QY3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGNO000";
const CONTRACT_FAILED = "CC9993SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGFAIL0";

describe("verification trust signal in approval flow (#583)", () => {
  it("distinguishes verified, no_record, explicit_unverified, and pending contract states", () => {
    const verified = resolveApprovalTrustSignal({
      contractId: CONTRACT_VERIFIED,
      status: "verified",
      recordId: "rec-verified-1",
      updatedAt: "2026-03-30T00:00:00.000Z",
    });
    expect(verified).toMatchObject({
      contractId: CONTRACT_VERIFIED,
      state: "verified",
      status: "verified",
      recordId: "rec-verified-1",
      label: "Verified contract",
      tone: "verified",
    });

    const noRecord = resolveApprovalTrustSignal({
      contractId: CONTRACT_NO_RECORD,
      status: "unverified",
    });
    expect(noRecord).toMatchObject({
      contractId: CONTRACT_NO_RECORD,
      state: "no_record",
      status: "unverified",
      label: "No verification record",
      tone: "neutral",
    });

    const failedRecord = resolveApprovalTrustSignal({
      contractId: CONTRACT_FAILED,
      status: "failed",
      recordId: "rec-failed-1",
    });
    expect(failedRecord).toMatchObject({
      contractId: CONTRACT_FAILED,
      state: "explicit_unverified",
      status: "failed",
      recordId: "rec-failed-1",
      label: "Explicitly unverified",
      tone: "warning",
    });

    const unverifiedWithRecord = resolveApprovalTrustSignal({
      contractId: CONTRACT_FAILED,
      status: "unverified",
      recordId: "rec-explicit-unverified-2",
    });
    expect(unverifiedWithRecord).toMatchObject({
      contractId: CONTRACT_FAILED,
      state: "explicit_unverified",
      status: "unverified",
      recordId: "rec-explicit-unverified-2",
      label: "Explicitly unverified",
      tone: "warning",
    });

    const building = resolveApprovalTrustSignal({
      contractId: CONTRACT_VERIFIED,
      status: "building",
      recordId: "rec-build-1",
    });
    expect(building).toMatchObject({
      state: "pending",
      label: "Verification in progress",
      tone: "pending",
    });
  });

  it("fetches trust signals via the verification client and degrades to no_record on network error", async () => {
    const client = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({
          contractId: CONTRACT_VERIFIED,
          status: "verified" as const,
          recordId: "rec-1",
        })
        .mockResolvedValueOnce({
          contractId: CONTRACT_FAILED,
          status: "failed" as const,
          recordId: "rec-2",
        })
        .mockRejectedValueOnce(new Error("Gateway timeout")),
    };

    const first = await fetchApprovalTrustSignal(CONTRACT_VERIFIED, client);
    expect(first.state).toBe("verified");
    expect(first.tone).toBe("verified");

    const second = await fetchApprovalTrustSignal(CONTRACT_FAILED, client);
    expect(second.state).toBe("explicit_unverified");
    expect(second.tone).toBe("warning");

    const fallback = await fetchApprovalTrustSignal(CONTRACT_NO_RECORD, client);
    expect(fallback.state).toBe("no_record");
    expect(fallback.tone).toBe("neutral");
  });

  it("extracts unique contract IDs from a transaction summary", () => {
    const ids = extractApprovalContractIds({
      movesValue: true,
      undecoded: false,
      operations: [
        {
          kind: "transfer",
          token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          to: "GDEST1234567890",
          amount: "10000000",
        },
        { kind: "contract-call", contract: CONTRACT_VERIFIED, fn: "swap" },
        { kind: "contract-call", contract: CONTRACT_VERIFIED, fn: "approve" },
        { kind: "contract-call", contract: CONTRACT_FAILED, fn: "execute" },
      ],
    });
    expect(ids).toEqual([CONTRACT_VERIFIED, CONTRACT_FAILED]);
    expect(extractApprovalContractIds(null)).toEqual([]);
  });

  it("surfaces the verification trust signal section and operation trust badge in ApprovalScreen", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalScreen, {
        approval: {
          id: "req-sign-1",
          origin: "https://dex.vellar.xyz",
          request: {
            method: "sign_transaction",
            params: { xdr: "AAAA", network: "testnet" },
          },
        },
        position: 1,
        total: 1,
        wallet: {
          address: CONTRACT_VERIFIED,
          network: "testnet",
          rpcUrl: "https://soroban-testnet.stellar.org",
          keyId: "key-1",
          walletWasmHash: "ab".repeat(32),
          webAppOrigin: "https://app.vellar.xyz",
        },
        onResolved: () => {},
        summaryOverride: {
          movesValue: false,
          undecoded: false,
          operations: [{ kind: "contract-call", contract: CONTRACT_NO_RECORD, fn: "swap" }],
        },
      }),
    );

    expect(html).toContain('data-testid="approval-trust-signal"');
    expect(html).toContain('data-testid="contract-verification-section"');
    expect(html).toContain("Contract verification");
    expect(html).toContain("No verification record");
  });
});
