import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletProvider } from "@/lib/wallet-context";
import AppEntry from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

describe("AppEntry (/app)", () => {
  it("renders the onboarding actions", () => {
    render(
      <WalletProvider>
        <AppEntry />
      </WalletProvider>,
    );
    expect(screen.getByRole("button", { name: "Create wallet" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    expect(screen.getByLabelText(/wallet name/i)).toBeDefined();
  });
});
