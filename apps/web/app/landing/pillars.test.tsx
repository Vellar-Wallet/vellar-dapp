import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { X402Pillars } from "./pillars";

describe("X402Pillars", () => {
  it("is one set of three cards, each pairing its copy with an example", () => {
    const { container } = render(<X402Pillars />);
    const cards = container.querySelectorAll(".lp-pillar");
    expect(cards).toHaveLength(3);
    for (const card of Array.from(cards)) {
      expect(card.querySelector(".lp-pillar-mock")).not.toBeNull();
    }
  });

  it("keeps every pillar's title and copy", () => {
    render(<X402Pillars />);
    for (const title of ["Verify and settle", "Bazaar discovery", "Built to be checked"]) {
      expect(screen.getByRole("heading", { name: title })).toBeDefined();
    }
    expect(screen.getByText(/never hand over keys/i)).toBeDefined();
    expect(screen.getByText(/can't be spammed for free/i)).toBeDefined();
    expect(screen.getByText(/nothing here has to be taken on trust/i)).toBeDefined();
  });

  it("no longer renders a second, separate row of example cards", () => {
    const { container } = render(<X402Pillars />);
    expect(container.querySelector(".lp-hero-cards")).toBeNull();
    expect(screen.queryByText(/seller · example/i)).toBeNull();
  });

  it("hides the examples from assistive tech, since each card's text carries the meaning", () => {
    const { container } = render(<X402Pillars />);
    for (const mock of Array.from(container.querySelectorAll(".lp-pillar-mock"))) {
      expect(mock.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("keeps the calls to action", () => {
    render(<X402Pillars />);
    expect(screen.getByRole("link", { name: "Quickstart" }).getAttribute("href")).toMatch(
      /^https:\/\/docs\.vellar\.xyz\//,
    );
    expect(screen.getByRole("link", { name: /facilitator on github/i })).toBeDefined();
  });
});
