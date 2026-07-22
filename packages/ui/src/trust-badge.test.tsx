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
});
