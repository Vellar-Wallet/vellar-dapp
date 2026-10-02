import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { X402Pillars } from "./pillars";

describe("X402Pillars", () => {
  it("is one set of three cards", () => {
    const { container } = render(<X402Pillars />);
    expect(container.querySelectorAll(".lp-pillar")).toHaveLength(3);
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

  it("has no example panels or second row of cards, only the three pillars", () => {
    const { container } = render(<X402Pillars />);
    expect(container.querySelector(".lp-hero-cards")).toBeNull();
    expect(container.querySelector(".lp-pillar-mock")).toBeNull();
    expect(screen.queryByText(/seller · example/i)).toBeNull();
    expect(screen.queryByText("Weather API")).toBeNull();
  });

  it("keeps the calls to action", () => {
    render(<X402Pillars />);
    expect(screen.getByRole("link", { name: "Quickstart" }).getAttribute("href")).toMatch(
      /^https:\/\/docs\.vellar\.xyz\//,
    );
    expect(screen.getByRole("link", { name: /facilitator on github/i })).toBeDefined();
  });
});
