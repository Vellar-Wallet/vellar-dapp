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

  it("renders a never-verified contract with a visually distinct tone from an explicitly-failed one (#587)", () => {
    render(<TrustBadge status="unverified" />);
    const neverVerified = screen.getByRole("status");
    cleanup();

    render(<TrustBadge status="failed" />);
    const explicitlyFailed = screen.getByRole("status");

    expect(neverVerified.getAttribute("data-tone")).not.toBe(
      explicitlyFailed.getAttribute("data-tone"),
    );
    expect(neverVerified.textContent).not.toBe(explicitlyFailed.textContent);
  });

  it("treats a dead-lettered verification job as a warning, not as unverified/neutral (#587)", () => {
    // A dead_letter job genuinely failed after exhausting retries; it must
    // not render identically to a contract that was never submitted at
    // all.
    render(<TrustBadge status="dead_letter" />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("data-tone")).toBe("warning");
    expect(badge.textContent).toContain("Verification failed");
  });

  it("exposes an accessible label describing the trust status", () => {
    render(<TrustBadge status="verified" />);
    expect(screen.getByLabelText("Contract trust status: Verified source")).toBeTruthy();
  });

  it("honors a custom label override", () => {
    render(<TrustBadge status="verified" label="Audited" />);
    expect(screen.getByRole("status").textContent).toContain("Audited");
  });
});

describe("TrustBadge lookup states", () => {
  it("shows a loading variant while the verification lookup is pending", () => {
    render(<TrustBadge status="loading" />);
    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("Checking verification…");
    expect(badge.getAttribute("data-tone")).toBe("pending");
    expect(badge.getAttribute("data-status")).toBe("loading");
  });

  it("shows an error variant distinct from unverified when the lookup fails", () => {
    const error = render(<TrustBadge status="error" />).container.firstChild as HTMLElement;
    const unverified = render(<TrustBadge status="unverified" />).container
      .firstChild as HTMLElement;

    expect(error.getAttribute("data-tone")).toBe("error");
    expect(error.getAttribute("data-status")).toBe("error");
    expect(error.textContent).toContain("Couldn't check verification");

    expect(unverified.getAttribute("data-tone")).toBe("neutral");
    expect(unverified.textContent).toContain("Unverified");

    expect(error.getAttribute("data-tone")).not.toBe(unverified.getAttribute("data-tone"));
    expect(error.textContent).not.toBe(unverified.textContent);
  });

  it("transitions from loading to verified", () => {
    const { rerender } = render(<TrustBadge status="loading" />);
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("loading");

    rerender(<TrustBadge status="verified" />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("data-status")).toBe("verified");
    expect(badge.getAttribute("data-tone")).toBe("verified");
    expect(badge.textContent).toContain("Verified source");
  });

  it("transitions from loading to failed", () => {
    const { rerender } = render(<TrustBadge status="loading" />);
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("loading");

    rerender(<TrustBadge status="failed" />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("data-status")).toBe("failed");
    expect(badge.getAttribute("data-tone")).toBe("warning");
    expect(badge.textContent).toContain("Verification failed");
  });

  it("transitions from loading to unverified", () => {
    const { rerender } = render(<TrustBadge status="loading" />);
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("loading");

    rerender(<TrustBadge status="unverified" />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("data-status")).toBe("unverified");
    expect(badge.getAttribute("data-tone")).toBe("neutral");
    expect(badge.textContent).toContain("Unverified");
  });
});
