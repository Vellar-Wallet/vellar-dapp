import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AgentKeyExpiry,
  DEFAULT_EXPIRY_WARNING_MS,
  expiryStatus,
  formatTimeRemaining,
} from "./agent-keys-card";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("agent key expiry status (#571)", () => {
  it("is 'none' when no expiry is set (no countdown)", () => {
    expect(expiryStatus(undefined, NOW)).toBe("none");
    expect(expiryStatus(null, NOW)).toBe("none");
    expect(expiryStatus("not-a-date", NOW)).toBe("none");
  });

  it("is 'ok' well before the threshold and 'warning' within it", () => {
    expect(expiryStatus(new Date(NOW + 72 * HOUR).toISOString(), NOW)).toBe("ok");
    expect(expiryStatus(new Date(NOW + 12 * HOUR).toISOString(), NOW)).toBe("warning");
  });

  it("is 'expired' once the expiry has passed — distinct from nearing", () => {
    expect(expiryStatus(new Date(NOW - 1).toISOString(), NOW)).toBe("expired");
    expect(expiryStatus(new Date(NOW - HOUR).toISOString(), NOW)).toBe("expired");
  });

  it("honours a configurable warning threshold", () => {
    const inThreeDays = new Date(NOW + 72 * HOUR).toISOString();
    expect(expiryStatus(inThreeDays, NOW, DEFAULT_EXPIRY_WARNING_MS)).toBe("ok");
    expect(expiryStatus(inThreeDays, NOW, 7 * 24 * HOUR)).toBe("warning");
  });
});

describe("agent key expiry formatting", () => {
  it("formats remaining time compactly", () => {
    expect(formatTimeRemaining(2 * 24 * HOUR + 3 * HOUR)).toBe("2d 3h");
    expect(formatTimeRemaining(5 * HOUR + 12 * 60_000)).toBe("5h 12m");
    expect(formatTimeRemaining(12 * 60_000)).toBe("12m");
    expect(formatTimeRemaining(30_000)).toBe("under 1m");
  });
});

describe("AgentKeyExpiry indicator", () => {
  it("shows no countdown when the key has no expiry", () => {
    render(<AgentKeyExpiry nowMs={NOW} />);
    const el = screen.getByTestId("agent-key-expiry");
    expect(el.getAttribute("data-expiry-status")).toBe("none");
    expect(el.textContent).toBe("No expiry");
  });

  it("shows a plain countdown when expiry is still far off", () => {
    render(<AgentKeyExpiry expiresAt={new Date(NOW + 72 * HOUR).toISOString()} nowMs={NOW} />);
    const el = screen.getByTestId("agent-key-expiry");
    expect(el.getAttribute("data-expiry-status")).toBe("ok");
    expect(el.textContent).toMatch(/Expires in 3d/);
    expect(el.className).not.toMatch(/amber/);
  });

  it("warns in amber within the threshold", () => {
    render(<AgentKeyExpiry expiresAt={new Date(NOW + 12 * HOUR).toISOString()} nowMs={NOW} />);
    const el = screen.getByTestId("agent-key-expiry");
    expect(el.getAttribute("data-expiry-status")).toBe("warning");
    expect(el.textContent).toMatch(/Expires in 12h/);
    expect(el.className).toMatch(/amber/);
  });

  it("distinguishes an already-expired key from one nearing expiry", () => {
    render(<AgentKeyExpiry expiresAt={new Date(NOW - HOUR).toISOString()} nowMs={NOW} />);
    const el = screen.getByTestId("agent-key-expiry");
    expect(el.getAttribute("data-expiry-status")).toBe("expired");
    expect(el.textContent).toMatch(/Expired 1h ago/);
    expect(el.className).toMatch(/red/);
  });
});
