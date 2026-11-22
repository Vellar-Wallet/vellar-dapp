import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-query", () => ({
  QueryClient: class QueryClient {},
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/wallet-context", () => ({
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { Providers } from "./providers";

describe("Providers localStorage resilience", () => {
  const originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(window, "localStorage", originalLocalStorage);
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when localStorage is available", () => {
    render(
      <Providers>
        <div>ok</div>
      </Providers>,
    );
    expect(screen.getByText("ok")).toBeTruthy();
  });

  it("renders children when localStorage access throws", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });

    expect(() =>
      render(
        <Providers>
          <div>safe</div>
        </Providers>,
      ),
    ).not.toThrow();
    expect(screen.getByText("safe")).toBeTruthy();
  });
});
