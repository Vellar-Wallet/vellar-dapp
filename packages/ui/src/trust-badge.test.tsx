import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TrustBadge } from "./trust-badge";

afterEach(cleanup);

describe("TrustBadge", () => {
  it("renders the verified label + tone", () => {
    render(<TrustBadge status="verified" />);
    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("Verified source");
    expect(badge.getAttribute("data-tone")).toBe("verified");
    expect(badge.getAttribute("data-status")).toBe("verified");
  });

  it("renders a warning tone for a failed verification", () => {
    render(<TrustBadge status="failed" />);
    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("Verification failed");
    expect(badge.getAttribute("data-tone")).toBe("warning");
  });

  it("treats submitted/building as pending", () => {
    render(<TrustBadge status="building" />);
    expect(screen.getByRole("status").getAttribute("data-tone")).toBe("pending");
  });

  it("defaults an unknown/unverified contract to neutral 'Unverified'", () => {
    render(<TrustBadge status="unverified" />);
    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("Unverified");
    expect(badge.getAttribute("data-tone")).toBe("neutral");
  });

  it("exposes an accessible label describing the trust status", () => {
    render(<TrustBadge status="verified" />);
    expect(screen.getByLabelText("Contract trust status: Verified source")).toBeTruthy();
  });

  it("honors a custom label override", () => {
    render(<TrustBadge status="verified" label="Audited" />);
    expect(screen.getByRole("status").textContent).toContain("Audited");
  });

  it("renders a loading variant while a verification lookup is pending", () => {
    render(<TrustBadge status="loading" />);
    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("Checking verification…");
    expect(badge.getAttribute("data-status")).toBe("loading");
    expect(badge.getAttribute("data-tone")).toBe("loading");
    expect(badge.getAttribute("aria-busy")).toBe("true");
  });

  it("renders an error variant distinct from unverified when the lookup itself fails", () => {
    const { unmount } = render(<TrustBadge status="error" />);
    const errorBadge = screen.getByRole("status");
    expect(errorBadge.textContent).toContain("Verification status unavailable");
    expect(errorBadge.getAttribute("data-status")).toBe("error");
    expect(errorBadge.getAttribute("data-tone")).toBe("error");
    expect(errorBadge.getAttribute("aria-busy")).toBe("false");
    const errorColor = (errorBadge as HTMLElement).style.color;
    unmount();

    render(<TrustBadge status="unverified" />);
    const unverifiedBadge = screen.getByRole("status");
    expect(unverifiedBadge.getAttribute("data-status")).toBe("unverified");
    expect(unverifiedBadge.getAttribute("data-tone")).toBe("neutral");
    expect((unverifiedBadge as HTMLElement).style.color).not.toBe(errorColor);
  });

  it("transitions cleanly from loading to verified", () => {
    const { rerender } = render(<TrustBadge status="loading" />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("data-status")).toBe("loading");
    expect(badge.getAttribute("aria-busy")).toBe("true");

    rerender(<TrustBadge status="verified" />);
    expect(badge.getAttribute("data-status")).toBe("verified");
    expect(badge.getAttribute("data-tone")).toBe("verified");
    expect(badge.getAttribute("aria-busy")).toBe("false");
    expect(badge.textContent).toContain("Verified source");
  });

  it("transitions cleanly from loading to unverified", () => {
    const { rerender } = render(<TrustBadge loading />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("data-status")).toBe("loading");

    rerender(<TrustBadge status="unverified" loading={false} />);
    expect(badge.getAttribute("data-status")).toBe("unverified");
    expect(badge.getAttribute("data-tone")).toBe("neutral");
    expect(badge.getAttribute("aria-busy")).toBe("false");
    expect(badge.textContent).toContain("Unverified");
  });

  it("transitions cleanly from loading to error when the lookup fails", () => {
    const { rerender } = render(<TrustBadge loading />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("data-status")).toBe("loading");

    rerender(<TrustBadge loading={false} error="Lookup failed: gateway timeout" />);
    expect(badge.getAttribute("data-status")).toBe("error");
    expect(badge.getAttribute("data-tone")).toBe("error");
    expect(badge.getAttribute("aria-busy")).toBe("false");
    expect(badge.textContent).toContain("Lookup failed: gateway timeout");
  });
});
