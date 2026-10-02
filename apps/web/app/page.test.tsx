import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Landing from "./page";

describe("Landing", () => {
  it("renders the hero, docs/GitHub CTAs, proofs, and FAQ, with no link into the wallet app", () => {
    render(<Landing />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /let agents pay your api/i,
    );
    expect(
      screen.getByRole("heading", { name: /the facilitator for x402 on stellar/i }),
    ).toBeDefined();

    const docsLinks = screen.getAllByRole("link", { name: /read the docs/i });
    expect(docsLinks.length).toBeGreaterThan(0);
    for (const link of docsLinks) {
      expect(link.getAttribute("href")).toMatch(/^https:\/\/docs\.vellar\.xyz\//);
    }

    const githubLinks = screen.getAllByRole("link", { name: /github/i });
    expect(githubLinks.length).toBeGreaterThan(0);
    for (const link of githubLinks) {
      expect(link.getAttribute("href")).toMatch(
        /^https:\/\/github\.com\/Vellar-Wallet\/vellar-facilitator/,
      );
    }

    expect(screen.getByRole("link", { name: /get the extension/i })).toBeDefined();
    expect(screen.getByText(/frequently asked questions/i)).toBeDefined();

    // The marketing landing must never link into the wallet app.
    const appLinks = screen.queryAllByRole("link").filter((l) => l.getAttribute("href") === "/app");
    expect(appLinks).toHaveLength(0);
  });

  it("floats its nav over the ink hero", () => {
    const { container } = render(<Landing />);
    expect(container.querySelector(".lp-nav-outer--float")).not.toBeNull();
  });
});
