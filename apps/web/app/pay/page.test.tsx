import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Networks } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentClient } from "vellar-sdk";
import type { WalletSession } from "@vellar/types";
import { WalletProvider } from "@/lib/wallet-context";
import PayPage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pay",
}));

const { getVerificationStatusMock } = vi.hoisted(() => ({
  getVerificationStatusMock: vi.fn(),
}));
vi.mock("@/lib/verification", async () => {
  const actual = await vi.importActual<typeof import("@/lib/verification")>("@/lib/verification");
  return {
    ...actual,
    getVerificationStatus: getVerificationStatusMock,
  };
});

const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PAYEE = "GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO";
const CONTRACT_PAYEE = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const TP = encodeURIComponent(Networks.TESTNET);

const session: WalletSession = {
  accountId: WALLET,
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-09-01T10:00:00.000Z",
  lastActiveAt: "2026-09-01T10:00:00.000Z",
};

function openWith(uri: string | null) {
  window.history.replaceState(
    null,
    "",
    uri === null ? "/pay" : `/pay?uri=${encodeURIComponent(uri)}`,
  );
}

function renderPay(payments: PaymentClient) {
  render(
    <WalletProvider payments={payments}>
      <PayPage />
    </WalletProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("vellar.session", JSON.stringify(session));
  getVerificationStatusMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/pay — incoming SEP-7 requests", () => {
  it("prefills the send flow from a valid request and never auto-submits", async () => {
    const preparePayment = vi.fn();
    openWith(`web+stellar:pay?destination=${PAYEE}&amount=3&msg=lunch&network_passphrase=${TP}`);
    renderPay({ preparePayment });

    const to = (await screen.findByLabelText(/recipient/i)) as HTMLInputElement;
    expect(to.value).toBe(PAYEE);
    expect((screen.getByLabelText(/amount/i) as HTMLInputElement).value).toBe("3");
    expect(screen.getByText(/unverified source/i)).toBeDefined();
    expect(screen.getByText(/lunch/)).toBeDefined();
    // Give any effect a chance to (wrongly) fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(preparePayment).not.toHaveBeenCalled();
  });

  it.each([
    [`web+stellar:tx?xdr=AAAA`, /only payment requests/i],
    [
      `web+stellar:pay?destination=${PAYEE}&amount=1&amount=900&network_passphrase=${TP}`,
      /ambiguous/i,
    ],
    [`web+stellar:pay?destination=${PAYEE}&memo=123&network_passphrase=${TP}`, /memo/i],
    [`web+stellar:pay?destination=${PAYEE}`, /public network/i],
    [`javascript:alert(1)`, /not a stellar payment request/i],
  ])("rejects %s with a clear error and no send form", async (uri, message) => {
    const preparePayment = vi.fn();
    openWith(uri);
    renderPay({ preparePayment });

    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(screen.getByText(/nothing was signed or sent/i)).toBeDefined();
    expect(screen.queryByLabelText(/recipient/i)).toBeNull();
    expect(preparePayment).not.toHaveBeenCalled();
  });

  it("rejects a request whose claimed origin can't be verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, text: async () => "" })),
    );
    openWith(
      `web+stellar:pay?destination=${PAYEE}&network_passphrase=${TP}&origin_domain=shop.example.com&signature=AAAA`,
    );
    renderPay({ preparePayment: vi.fn() });

    expect((await screen.findByRole("alert")).textContent).toMatch(/stellar\.toml/);
    expect(screen.queryByLabelText(/recipient/i)).toBeNull();
  });

  it("accepts a pasted request when opened without one", async () => {
    openWith(null);
    renderPay({ preparePayment: vi.fn() });

    fireEvent.change(await screen.findByLabelText(/payment request/i), {
      target: { value: `web+stellar:pay?destination=${PAYEE}&network_passphrase=${TP}` },
    });
    fireEvent.click(screen.getByRole("button", { name: /open request/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/recipient/i) as HTMLInputElement).value).toBe(PAYEE),
    );
  });

  describe("contract destination verification (#703)", () => {
    it("warns when the destination contract has no verification record", async () => {
      getVerificationStatusMock.mockResolvedValue({
        contractId: CONTRACT_PAYEE,
        status: "unverified",
      });
      openWith(`web+stellar:pay?destination=${CONTRACT_PAYEE}&network_passphrase=${TP}`);
      renderPay({ preparePayment: vi.fn() });

      await screen.findByLabelText(/recipient/i);
      expect(getVerificationStatusMock).toHaveBeenCalledWith(CONTRACT_PAYEE);
      expect(
        await screen.findByText(/no verified source\. review carefully/i),
      ).toBeDefined();
      expect(screen.getByLabelText(/contract verification status/i)).toBeDefined();
    });

    it("shows no warning when the destination contract is verified", async () => {
      getVerificationStatusMock.mockResolvedValue({
        contractId: CONTRACT_PAYEE,
        status: "verified",
      });
      openWith(`web+stellar:pay?destination=${CONTRACT_PAYEE}&network_passphrase=${TP}`);
      renderPay({ preparePayment: vi.fn() });

      await screen.findByLabelText(/recipient/i);
      await waitFor(() => expect(getVerificationStatusMock).toHaveBeenCalled());
      expect(screen.queryByText(/no verified source/i)).toBeNull();
    });

    it("surfaces a couldn't-check state when the verification lookup fails, not a silent pass", async () => {
      getVerificationStatusMock.mockRejectedValue(new Error("network error"));
      openWith(`web+stellar:pay?destination=${CONTRACT_PAYEE}&network_passphrase=${TP}`);
      renderPay({ preparePayment: vi.fn() });

      await screen.findByLabelText(/recipient/i);
      expect(await screen.findByText(/couldn't check verification/i)).toBeDefined();
      expect(screen.queryByText(/no verified source/i)).toBeNull();
    });

    it("does not call the verification lookup for a regular account destination", async () => {
      openWith(`web+stellar:pay?destination=${PAYEE}&network_passphrase=${TP}`);
      renderPay({ preparePayment: vi.fn() });

      await screen.findByLabelText(/recipient/i);
      await new Promise((r) => setTimeout(r, 50));
      expect(getVerificationStatusMock).not.toHaveBeenCalled();
      expect(screen.queryByLabelText(/contract verification status/i)).toBeNull();
    });
  });
});
