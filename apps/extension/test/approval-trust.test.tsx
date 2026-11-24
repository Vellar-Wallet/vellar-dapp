import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalScreen } from "../entrypoints/popup/ApprovalScreen";
import type { PendingApprovalSummary } from "../lib/messages";

const { observeTrustUpdate } = vi.hoisted(() => ({ observeTrustUpdate: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    // React silently ignores state updates after unmount. Observe the
    // approval badge's setter directly so the test detects those calls.
    useState<S>(initial: S | (() => S)) {
      const [value, setValue] = react.useState(initial);
      if (initial !== "loading") return [value, setValue] as const;
      const setTrust: typeof setValue = (next) => {
        observeTrustUpdate(next);
        setValue(next);
      };
      return [value, setTrust] as const;
    },
  };
});

vi.mock("wxt/browser", () => ({ browser: {} }));
vi.mock("../lib/tx-summary", () => ({
  summarizeTransaction: () => ({
    operations: [{ kind: "contract-call", contract: "C-CONTRACT", fn: "swap" }],
    movesValue: false,
  }),
}));

const approval: PendingApprovalSummary = {
  id: "approval-1",
  origin: "https://dapp.example",
  request: { method: "sign_transaction", params: { xdr: "mock-xdr", network: "testnet" } },
};

function renderApproval() {
  const lookup = Promise.withResolvers<Response>();
  const fetchStatus = vi.fn(() => lookup.promise);
  vi.stubGlobal("fetch", fetchStatus);
  const view = render(
    <ApprovalScreen
      approval={approval}
      position={1}
      total={1}
      wallet={undefined}
      onResolved={vi.fn()}
    />,
  );
  return { ...view, lookup, fetchStatus };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  observeTrustUpdate.mockClear();
});

describe("approval TrustBadge lookup", () => {
  it.each(["verified", "error"] as const)(
    "transitions from loading to %s while mounted",
    async (status) => {
      const { lookup, fetchStatus } = renderApproval();
      const badge = await screen.findByRole("status");
      expect(badge.getAttribute("data-status")).toBe("loading");
      expect(fetchStatus).toHaveBeenCalledOnce();

      await act(async () => {
        if (status === "error") lookup.reject(new Error("lookup failed"));
        else lookup.resolve(Response.json({ status, recordId: "record-1" }));
      });
      expect(badge.getAttribute("data-status")).toBe(status);
      expect(observeTrustUpdate).toHaveBeenCalledWith(status);
    },
  );

  it.each(["verified", "error"] as const)(
    "ignores a late %s result after unmount",
    async (status) => {
      const { lookup, fetchStatus, unmount } = renderApproval();
      expect((await screen.findByRole("status")).getAttribute("data-status")).toBe("loading");
      expect(fetchStatus).toHaveBeenCalledOnce();
      unmount();
      observeTrustUpdate.mockClear();

      await act(async () => {
        if (status === "error") lookup.reject(new Error("lookup failed"));
        else lookup.resolve(Response.json({ status, recordId: "record-1" }));
      });
      expect(observeTrustUpdate).not.toHaveBeenCalled();
    },
  );
});
