// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import type { SignerEntry } from "@/lib/signer-model";
import {
  AgentKeysCard,
  computeAgentKeyExpiryStatus,
  DEFAULT_EXPIRY_WARNING_THRESHOLD_MS,
} from "./agent-keys-card";

const { useSignersMock } = vi.hoisted(() => ({
  useSignersMock: vi.fn(),
}));

vi.mock("@/lib/signers", () => ({
  useSigners: useSignersMock,
  useInvalidateSigners: () => vi.fn(),
}));

vi.mock("@/lib/balances", () => ({
  useBalances: () => ({
    data: [{ symbol: "XLM", contractId: "CNATIVE", decimals: 7, amount: 100_000_000n }],
    isPending: false,
  }),
}));

const session: WalletSession = {
  accountId: "CWALLET571",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T09:00:00.000Z",
  lastActiveAt: "2026-07-16T09:00:00.000Z",
  keyId: "cred-571",
};

const NOW_MS = Date.parse("2026-07-16T12:00:00.000Z");

function makeAgentSigner(overrides: Partial<SignerEntry>): SignerEntry {
  return {
    id: "Ed25519:GAGENTKEY123456",
    kind: "agent",
    key: { kind: "Ed25519", value: "GAGENTKEY123456" },
    status: "live",
    storage: "persistent",
    isCurrent: false,
    isDurableAdmin: false,
    ...overrides,
  };
}

describe("AgentKeysCard expiry countdown (#571)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("computes expiry status across nearing-expiry, already-expired, no-expiry, and healthy keys", () => {
    const twoHoursLater = new Date(NOW_MS + 2 * 60 * 60 * 1000).toISOString();
    expect(
      computeAgentKeyExpiryStatus(twoHoursLater, NOW_MS, DEFAULT_EXPIRY_WARNING_THRESHOLD_MS),
    ).toEqual({
      kind: "nearing-expiry",
      remainingMs: 2 * 60 * 60 * 1000,
      countdown: "2h 0m",
      label: "Expires in 2h 0m",
    });

    const oneHourAgo = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
    expect(
      computeAgentKeyExpiryStatus(oneHourAgo, NOW_MS, DEFAULT_EXPIRY_WARNING_THRESHOLD_MS),
    ).toEqual({
      kind: "expired",
      remainingMs: 0,
      label: "Expired",
    });

    expect(
      computeAgentKeyExpiryStatus(undefined, NOW_MS, DEFAULT_EXPIRY_WARNING_THRESHOLD_MS),
    ).toEqual({
      kind: "no-expiry",
    });
  });

  it("renders a countdown warning indicator for an agent key within the configurable expiry threshold", () => {
    const expiresIn90Min = new Date(NOW_MS + 90 * 60 * 1000).toISOString();
    useSignersMock.mockReturnValue({
      data: [makeAgentSigner({ expiresAt: expiresIn90Min })],
      isPending: false,
      isError: false,
    });

    render(
      <AgentKeysCard
        session={session}
        nowMs={NOW_MS}
        expiryWarningThresholdMs={2 * 60 * 60 * 1000}
      />,
    );

    const countdown = screen.getByTestId("agent-key-expiry-countdown");
    expect(countdown.textContent).toContain("Expires in 1h 30m");
    expect(screen.queryByTestId("agent-key-expired-badge")).toBeNull();
    expect(screen.queryByTestId("agent-key-no-expiry")).toBeNull();
  });

  it("distinguishes an already-expired agent key from one nearing expiry", () => {
    const expiredAt = new Date(NOW_MS - 15 * 60 * 1000).toISOString();
    useSignersMock.mockReturnValue({
      data: [makeAgentSigner({ expiresAt: expiredAt, status: "expired" })],
      isPending: false,
      isError: false,
    });

    render(<AgentKeysCard session={session} nowMs={NOW_MS} />);

    const expiredBadge = screen.getByTestId("agent-key-expired-badge");
    expect(expiredBadge.textContent).toBe("Expired");
    expect(screen.queryByTestId("agent-key-expiry-countdown")).toBeNull();
  });

  it("does not show a countdown when an agent key has no expiry set", () => {
    useSignersMock.mockReturnValue({
      data: [makeAgentSigner({ expiresAt: undefined })],
      isPending: false,
      isError: false,
    });

    render(<AgentKeysCard session={session} nowMs={NOW_MS} />);

    const noExpiry = screen.getByTestId("agent-key-no-expiry");
    expect(noExpiry.textContent).toMatch(/no expiry/i);
    expect(screen.queryByTestId("agent-key-expiry-countdown")).toBeNull();
    expect(screen.queryByTestId("agent-key-expired-badge")).toBeNull();
  });
});
