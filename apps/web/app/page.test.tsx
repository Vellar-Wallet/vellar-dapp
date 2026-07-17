import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Landing from "./page";

describe("Landing", () => {
  it("renders the hero, CTAs into the app, features, and FAQ", () => {
    render(<Landing />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/secured by passkeys/i);

    const launchLinks = screen.getAllByRole("link", { name: /launch (web )?app/i });
    expect(launchLinks.length).toBeGreaterThan(0);
    for (const link of launchLinks) {
      expect(link.getAttribute("href")).toBe("/app");
    }

    expect(screen.getByRole("heading", { name: "Programmable policies" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Contract verification" })).toBeDefined();
    expect(screen.getByText(/frequently asked questions/i)).toBeDefined();
  });
});
