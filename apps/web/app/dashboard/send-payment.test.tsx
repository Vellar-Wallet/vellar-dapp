import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentClient, PreparedPayment } from "vellar-sdk";
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

  it("displays an inline balance error and blocks entering the passkey review step when amount exceeds balance", async () => {
    const preparePayment = vi.fn();
    render(
      <WalletProvider payments={{ preparePayment }}>
        <SendPayment
          from={FROM}
          token={{ ...xlm, amount: 10_000_000n }}
          network="testnet"
          onSuccess={vi.fn()}
        />
      </WalletProvider>,
    );

    expect(screen.getByTestId("available-balance").textContent).toContain("Available: 1 XLM");
    fireEvent.change(screen.getByLabelText(/recipient/i), { target: { value: TO } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "2.5" } });

    const inlineErr = await screen.findByTestId("balance-error");
    expect(inlineErr.textContent).toMatch(/Insufficient XLM balance \(available: 1 XLM\)/i);

    fireEvent.click(screen.getByRole("button", { name: /review payment/i }));
    await waitFor(() => {
      expect(preparePayment).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: /review payment/i })).toBeNull();
    });
  });

  it("blocks submission and shows inline error when the balance decreases between form load and submit", async () => {
    const preparePayment = vi.fn().mockResolvedValue(prepared());
    const { rerender } = render(
      <WalletProvider payments={{ preparePayment }}>
        <SendPayment
          from={FROM}
          token={{ ...xlm, amount: 50_000_000n }}
          network="testnet"
          onSuccess={vi.fn()}
        />
      </WalletProvider>,
    );

    // At form load, balance is 5 XLM; entering 2.5 XLM is valid.
    fireEvent.change(screen.getByLabelText(/recipient/i), { target: { value: TO } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "2.5" } });
    expect(screen.queryByTestId("balance-error")).toBeNull();

    // Balance decreases to 1 XLM before the user submits.
    rerender(
      <WalletProvider payments={{ preparePayment }}>
        <SendPayment
          from={FROM}
          token={{ ...xlm, amount: 10_000_000n }}
          network="testnet"
          onSuccess={vi.fn()}
        />
      </WalletProvider>,
    );

    const inlineErr = await screen.findByTestId("balance-error");
    expect(inlineErr.textContent).toMatch(/Insufficient XLM balance \(available: 1 XLM\)/i);

    fireEvent.click(screen.getByRole("button", { name: /review payment/i }));
    await waitFor(() => {
      expect(preparePayment).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: /review payment/i })).toBeNull();
    });
  });

  it("re-checks getBalance on submit and blocks passkey review if balance dropped on-chain", async () => {
    const preparePayment = vi.fn().mockResolvedValue(prepared());
    const getBalance = vi.fn().mockResolvedValue(15_000_000n); // dropped from 5 XLM to 1.5 XLM
    render(
      <WalletProvider payments={{ preparePayment }}>
        <SendPayment
          from={FROM}
          token={{ ...xlm, amount: 50_000_000n }}
          getBalance={getBalance}
          network="testnet"
          onSuccess={vi.fn()}
        />
      </WalletProvider>,
    );

    fireEvent.change(screen.getByLabelText(/recipient/i), { target: { value: TO } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: /review payment/i }));

    const inlineErr = await screen.findByTestId("balance-error");
    expect(inlineErr.textContent).toMatch(/Insufficient XLM balance \(available: 1\.5 XLM\)/i);
    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(preparePayment).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /review payment/i })).toBeNull();
  });

  describe("prefilled from a payment request", () => {
    function renderRequest(
      payments: PaymentClient,
      request: { originDomain: string | null; msg?: string },
      amount?: string,
    ) {
      render(
        <WalletProvider payments={payments}>
          <SendPayment
            from={FROM}
            token={xlm}
            network="testnet"
            onSuccess={vi.fn()}
            prefill={{ to: TO, ...(amount !== undefined && { amount }) }}
            request={request}
          />
        </WalletProvider>,
      );
    }

    it("locks the requested fields and flags an unverified source", () => {
      renderRequest({ preparePayment: vi.fn() }, { originDomain: null }, "2.5");
      const to = screen.getByLabelText(/recipient/i) as HTMLInputElement;
      const amount = screen.getByLabelText(/amount/i) as HTMLInputElement;
      expect(to.value).toBe(TO);
      expect(to.readOnly).toBe(true);
      expect(amount.value).toBe("2.5");
      expect(amount.readOnly).toBe(true);
      expect(screen.getByText(/unverified source/i)).toBeDefined();
    });

    it("lets the payer enter the amount when the request leaves it open", () => {
      renderRequest({ preparePayment: vi.fn() }, { originDomain: null });
      expect((screen.getByLabelText(/amount/i) as HTMLInputElement).readOnly).toBe(false);
    });

    it("never prepares or signs on its own — review then passkey confirm still required", async () => {
      const confirm = vi.fn().mockResolvedValue({ hash: "txhash123" });
      const preparePayment = vi.fn().mockResolvedValue(prepared(confirm));
      renderRequest(
        { preparePayment },
        { originDomain: "shop.example.com", msg: "<b>order 7</b>" },
        "2.5",
      );

      expect(preparePayment).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /review payment/i }));
      const dialog = await screen.findByRole("dialog", { name: /review payment/i });

      expect(preparePayment).toHaveBeenCalledWith({
        from: FROM,
        to: TO,
        token: xlm,
        amount: 25000000n,
      });
      expect(confirm).not.toHaveBeenCalled();
      // Every field, the verified origin and the requester's note are visible before signing.
      expect(dialog.textContent).toContain("shop.example.com");
      expect(dialog.textContent).toContain(TO);
      expect(dialog.textContent).toContain("CNATIVE");
      expect(dialog.textContent).toContain("2.5 XLM");
      // The note renders as text, not markup.
      expect(dialog.querySelector("b")).toBeNull();
      expect(dialog.textContent).toContain("<b>order 7</b>");
    });
  });
});
