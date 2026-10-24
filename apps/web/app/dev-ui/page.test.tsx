import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletProvider } from "@/lib/wallet-context";
import DevUi from "./page";

// Keep the real `notFound` export — only stub the navigation hooks AppShellView
// needs, so the guard under test (process.env.NODE_ENV === "production" ⇒
// notFound()) calls the genuine next/navigation implementation (#706).
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/dev-ui",
  };
});

function renderDevUi() {
  return render(
    <WalletProvider>
      <DevUi />
    </WalletProvider>,
  );
}

describe("dev-ui page production guard (#706)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls next/navigation's notFound() in production, not a hand-rolled check", async () => {
    vi.stubEnv("NODE_ENV", "production");

    // notFound() throws synchronously during render (it's how App Router
    // routes to the not-found boundary) — React surfaces it as a thrown
    // error from the render call itself.
    let thrown: unknown;
    try {
      renderDevUi();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    // The exact digest next/navigation's notFound() sets — asserting on it
    // (rather than just "something threw") is what proves this is really
    // Next's own not-found mechanism and not some other unrelated error.
    expect((thrown as Error & { digest?: string }).digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("remains fully accessible and renders its content in development", () => {
    vi.stubEnv("NODE_ENV", "development");

    const { getByText } = renderDevUi();

    expect(getByText(/account balance/i)).toBeDefined();
  });

  it("remains accessible in test environments too (NODE_ENV !== 'production')", () => {
    vi.stubEnv("NODE_ENV", "test");

    expect(() => renderDevUi()).not.toThrow();
  });
});
