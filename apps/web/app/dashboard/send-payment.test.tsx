import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentClient, PreparedPayment } from "@vela/wallet-sdk";
import { WalletProvider } from "@/lib/wallet-context";
import { SendPayment } from "./send-payment";

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("@/lib/track", () => ({ trackTransaction: trackMock }));

const xlm = { symbol: "XLM", contractId: "CNATIVE", decimals: 7 };
const FROM = "CSMARTWALLET";
const TO = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function prepared(confirm = vi.fn().mockResolvedValue({ hash: "txhash123" })): PreparedPayment {
  return {
    review: { from: FROM, to: TO, token: xlm, amount: 25000000n, network: "testnet" },
    confirm,
  };
}

function renderSend(payments: PaymentClient, onSuccess = vi.fn()) {
  render(
    <WalletProvider payments={payments}>
      <SendPayment from={FROM} token={xlm} network="testnet" onSuccess={onSuccess} />
    </WalletProvider>,
  );
  return { onSuccess };
}

async function fillAndReview() {
  fireEvent.change(screen.getByLabelText(/recipient/i), { target: { value: TO } });
  fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "2.5" } });
  fireEvent.click(screen.getByRole("button", { name: /review payment/i }));
  await screen.findByRole("dialog", { name: /review payment/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  trackMock.mockResolvedValue("success");
});

describe("SendPayment", () => {
  it("prepares and shows the explicit review with all payment details", async () => {
    const preparePayment = vi.fn().mockResolvedValue(prepared());
    renderSend({ preparePayment });

    await fillAndReview();

    expect(preparePayment).toHaveBeenCalledWith({
      from: FROM,
      to: TO,
      token: xlm,
      amount: 25000000n,
    });
    expect(screen.getByText(TO)).toBeDefined();
    expect(screen.getByText("2.5 XLM")).toBeDefined();
    expect(screen.getByText("testnet")).toBeDefined();
  });

  it("rejects malformed amounts before ever building a transaction", async () => {
    const preparePayment = vi.fn();
    renderSend({ preparePayment });

    fireEvent.change(screen.getByLabelText(/recipient/i), { target: { value: TO } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /review payment/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not a valid amount/i);
    expect(preparePayment).not.toHaveBeenCalled();
  });

  it("cancel returns to the form without signing or submitting", async () => {
    const confirm = vi.fn();
    renderSend({ preparePayment: vi.fn().mockResolvedValue(prepared(confirm)) });

    await fillAndReview();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await screen.findByRole("button", { name: /review payment/i });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirm signs, submits, tracks, and reports success", async () => {
    const { onSuccess } = renderSend(
      { preparePayment: vi.fn().mockResolvedValue(prepared()) },
      vi.fn(),
    );

    await fillAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    expect(await screen.findByText(/payment confirmed/i)).toBeDefined();
    expect(trackMock).toHaveBeenCalledWith("txhash123");
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(screen.getByText("txhash123")).toBeDefined();
  });

  it("reports a failed transaction as failed, not success", async () => {
    trackMock.mockResolvedValue("failed");
    const { onSuccess } = renderSend({ preparePayment: vi.fn().mockResolvedValue(prepared()) });

    await fillAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    expect(await screen.findByText(/payment failed/i)).toBeDefined();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("returns quietly to review when the user cancels the passkey prompt", async () => {
    const cancel = new Error("dismissed");
    cancel.name = "NotAllowedError";
    renderSend({
      preparePayment: vi.fn().mockResolvedValue(prepared(vi.fn().mockRejectedValue(cancel))),
    });

    await fillAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    expect(await screen.findByRole("button", { name: /confirm with passkey/i })).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows submission failures on the review step for retry", async () => {
    renderSend({
      preparePayment: vi
        .fn()
        .mockResolvedValue(prepared(vi.fn().mockRejectedValue(new Error("relayer down")))),
    });

    await fillAndReview();
    fireEvent.click(screen.getByRole("button", { name: /confirm with passkey/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    expect(screen.getByRole("button", { name: /confirm with passkey/i })).toBeDefined();
  });

  it("surfaces prepare failures (e.g. simulation) as an error on the form", async () => {
    renderSend({
      preparePayment: vi.fn().mockRejectedValue(new Error("insufficient balance")),
    });

    fireEvent.change(screen.getByLabelText(/recipient/i), { target: { value: TO } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: /review payment/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/insufficient balance/i);
  });
});
