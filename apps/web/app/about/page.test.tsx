import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import About from "./page";

describe("About", () => {
  it("renders its headline and the four product pillars", () => {
    render(<About />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /the facilitator for x402 on stellar/i,
    );
    for (const name of ["The facilitator", "The Bazaar", "Buyer tools", "Seller tools"]) {
      expect(screen.getByText(name)).toBeDefined();
    }
  });

  it("keeps the ordinary paper nav, not the floating one", () => {
    // About opens on a white page. The floating nav has light type and an
    // inverted logo, so on this page it would make the logo invisible.
    const { container } = render(<About />);
    const bar = container.querySelector(".lp-nav-outer");
    expect(bar).not.toBeNull();
    expect(bar!.className).not.toContain("lp-nav-outer--float");
  });

  it("does not link into the wallet app", () => {
    render(<About />);
    const appLinks = screen.queryAllByRole("link").filter((l) => l.getAttribute("href") === "/app");
    expect(appLinks).toHaveLength(0);
  });
});
