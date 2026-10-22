import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@vellar/types";
import { WalletProvider } from "@/lib/wallet-context";
import type { SignerEntry } from "@/lib/signer-model";
import Settings from "./page";

const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/settings",
}));

const { useSessionsMock, mutateAsync } = vi.hoisted(() => ({
  useSessionsMock: vi.fn(),
  mutateAsync: vi.fn(),
}));
vi.mock("@/lib/sessions", () => ({
  useSessions: useSessionsMock,
  useRevokeSession: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/lib/agent-keys", () => ({
  useAgentKeys: () => ({ data: [], isPending: false, isError: false }),
  useRevokeAgentKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// WalletUpgradeCard's data seam (#572). Mocked like the other hooks so the
// settings suite does not need a QueryClientProvider just to render the shell.
vi.mock("@/lib/wallet-version", () => ({
  useWalletVersion: () => ({
    data: {
      state: "current",
      currentHash: "fdefad64b96837147e1c333e51f537b696eab925e9f147e63d597c04e3c903f0",
      targetHash: "fdefad64b96837147e1c333e51f537b696eab925e9f147e63d597c04e3c903f0",
    },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useUpgradeWallet: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Signer hooks (#401): the query is mocked at the hook seam (like sessions);
// the pure classification/lockout logic it wraps is exercised for real via
// the actual signer-model module.
const { useSignersMock, revokeSigner, addPasskey, invalidateSigners, signersRefetch } = vi.hoisted(
  () => ({
    useSignersMock: vi.fn(),
    revokeSigner: vi.fn(),
    addPasskey: vi.fn(),
    invalidateSigners: vi.fn(),
    signersRefetch: vi.fn(),
  }),
);
vi.mock("@/lib/signers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/signers")>();
  return {
    ...actual,
    useSigners: useSignersMock,
    useRevokeSigner: () => ({ mutateAsync: revokeSigner, isPending: false }),
    useAddPasskey: () => ({ mutateAsync: addPasskey, isPending: false }),
    useInvalidateSigners: () => invalidateSigners,
  };
});

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("@/lib/track", () => ({ trackTransaction: trackMock }));

vi.mock("@/lib/balances", () => ({
  useBalances: () => ({
    data: [{ symbol: "XLM", contractId: "CNATIVE", decimals: 7, amount: 250_000_000n }],
    isPending: false,
  }),
}));

const { runtimeMock } = vi.hoisted(() => ({ runtimeMock: vi.fn() }));
vi.mock("@/lib/connector-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/connector-factory")>();
  return { ...actual, getWalletRuntime: runtimeMock };
});

const { validateMock, generateMock, simulateMock, deployInstanceMock, recordMock } = vi.hoisted(
  () => ({
    validateMock: vi.fn(),
    generateMock: vi.fn(),
    simulateMock: vi.fn(),
    deployInstanceMock: vi.fn(),
    recordMock: vi.fn(),
  }),
);
vi.mock("@/lib/policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/policy")>();
  return {
    ...actual,
    validatePolicy: validateMock,
    generatePolicy: generateMock,
    simulatePolicyDeploy: simulateMock,
    deployPolicyInstance: deployInstanceMock,
    recordDeployment: recordMock,
  };
});

const { generateAgentKeyMock } = vi.hoisted(() => ({ generateAgentKeyMock: vi.fn() }));
vi.mock("@/lib/agent-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-key")>();
  return { ...actual, generateAgentKey: generateAgentKeyMock };
});

const walletSession: WalletSession = {
  accountId: "CACCOUNT",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T09:00:00.000Z",
  lastActiveAt: "2026-07-16T09:00:00.000Z",
  serverSessionId: "sess-current",
  keyId: "cred-current",
};

const records = [
  {
    id: "sess-current",
    contractId: "CACCOUNT",
    network: "testnet",
    createdAt: "2026-07-16T09:00:00.000Z",
    lastActiveAt: "2026-07-16T12:00:00.000Z",
  },
];

function passkey(value: string): SignerEntry {
  return {
    id: `Secp256r1:${value}`,
    kind: "passkey",
    key: { kind: "Secp256r1", value },
    status: "live",
    storage: "persistent",
    isCurrent: value === "cred-current",
    isDurableAdmin: true,
  };
}
const deviceSession: SignerEntry = {
  id: "Ed25519:GDEVICE",
  kind: "device-session",
  key: { kind: "Ed25519", value: "GDEVICE" },
  status: "live",
  storage: "temporary",
  expiresAt: "2026-07-23T09:00:00.000Z",
  isCurrent: false,
  isDurableAdmin: false,
};
const agentKey: SignerEntry = {
  id: "Ed25519:GAGENT",
  kind: "agent",
  key: { kind: "Ed25519", value: "GAGENT" },
  status: "live",
  storage: "persistent",
  expiresAt: "2026-07-17T09:00:00.000Z",
  limits: [{ contract: "CNATIVE", requiredCoSigners: [{ kind: "Policy", value: "CPOLICY" }] }],
  isCurrent: false,
  isDurableAdmin: false,
};
const policySigner: SignerEntry = {
  id: "Policy:CPOLICY",
  kind: "policy",
  key: { kind: "Policy", value: "CPOLICY" },
  status: "live",
  storage: "persistent",
  isCurrent: false,
  isDurableAdmin: false,
};

function signersData(data: SignerEntry[], over: Record<string, unknown> = {}) {
  useSignersMock.mockReturnValue({
    data,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: signersRefetch,
    ...over,
  });
}

function renderSettings() {
  return render(
    <WalletProvider>
      <Settings />
    </WalletProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  // jsdom has no WebAuthn; the add-passkey card gates on it (technical-doc §5.1).
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window, "PublicKeyCredential", {
    value: function PKC() {},
    configurable: true,
  });
  window.localStorage.setItem("vellar.session", JSON.stringify(walletSession));
  useSessionsMock.mockReturnValue({
    data: records,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
  mutateAsync.mockResolvedValue(undefined);
  trackMock.mockResolvedValue("success");
  signersRefetch.mockResolvedValue(undefined);
  signersData([
    passkey("cred-current"),
    passkey("cred-phone"),
    deviceSession,
    agentKey,
    policySigner,
  ]);
});

describe("Settings — signer list (#401)", () => {
  it("lists every signer kind from chain, visually distinguished", async () => {
    renderSettings();
    // "This device" is marked on both the current passkey and the current session.
    expect(await screen.findAllByText("This device")).toHaveLength(2);
    expect(screen.getAllByTestId("signer-passkey")).toHaveLength(2);
    expect(screen.getByTestId("signer-device-session")).toBeDefined();
    expect(screen.getByTestId("signer-agent")).toBeDefined();
    expect(screen.getByTestId("signer-policy")).toBeDefined();
    // The agent row shows its on-chain limits: the token and the required policy.
    expect(within(screen.getByTestId("signer-agent")).getByText(/requires Policy/)).toBeDefined();
  });

  it("refreshes from chain on demand (cross-device changes)", async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: /refresh from chain/i }));
    expect(signersRefetch).toHaveBeenCalled();
  });

  it("shows the error state with retry when the chain read fails", async () => {
    signersData([], { data: undefined, isError: true });
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: /^retry$/i }));
    expect(signersRefetch).toHaveBeenCalled();
  });
});

describe("Settings — revocation (#401)", () => {
  it("2 passkeys → revoking the other one is an on-chain removal after a kind-specific confirmation", async () => {
    revokeSigner.mockResolvedValue({ hash: "removetx" });
    renderSettings();
    const rows = await screen.findAllByTestId("signer-passkey");
    const phone = rows.find((r) => r.textContent?.includes("cred-phone"))!;
    fireEvent.click(within(phone).getByRole("button", { name: /revoke passkey/i }));
    expect(within(phone).getByText(/revoke this passkey\?/i)).toBeDefined();
    fireEvent.click(within(phone).getByRole("button", { name: /approve revoke with passkey/i }));
    await waitFor(() =>
      expect(revokeSigner).toHaveBeenCalledWith({ kind: "Secp256r1", value: "cred-phone" }),
    );
    expect(await within(phone).findByText(/removed on-chain/i)).toBeDefined();
    expect(trackMock).toHaveBeenCalledWith("removetx");
    expect(signersRefetch).toHaveBeenCalled();
  });

  it("1 passkey → the revoke is blocked before any prompt (lockout protection)", async () => {
    signersData([passkey("cred-current"), agentKey]);
    renderSettings();
    const row = await screen.findByTestId("signer-passkey");
    const button = within(row).getByRole("button", {
      name: /revoke passkey/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(row).getByTestId("lockout-guard").textContent).toMatch(/only passkey/i);
    fireEvent.click(button);
    expect(revokeSigner).not.toHaveBeenCalled();
  });

  it("surfaces the account contract's own lockout refusal when it rejects a removal", async () => {
    revokeSigner.mockRejectedValue(new Error("HostError: Error(Contract, #103)"));
    renderSettings();
    const rows = await screen.findAllByTestId("signer-passkey");
    const phone = rows.find((r) => r.textContent?.includes("cred-phone"))!;
    fireEvent.click(within(phone).getByRole("button", { name: /revoke passkey/i }));
    fireEvent.click(within(phone).getByRole("button", { name: /approve revoke with passkey/i }));
    expect((await within(phone).findByRole("alert")).textContent).toMatch(/lock you out/i);
  });

  it("revokes an agent key (remote kill) and detaches a policy through the same on-chain path", async () => {
    revokeSigner.mockResolvedValue({ hash: "tx" });
    renderSettings();
    const agent = await screen.findByTestId("signer-agent");
    fireEvent.click(within(agent).getByRole("button", { name: /revoke agent key/i }));
    expect(within(agent).getByText(/remote kill switch/i)).toBeDefined();
    fireEvent.click(within(agent).getByRole("button", { name: /approve revoke with passkey/i }));
    await waitFor(() =>
      expect(revokeSigner).toHaveBeenCalledWith({ kind: "Ed25519", value: "GAGENT" }),
    );

    const policy = screen.getByTestId("signer-policy");
    fireEvent.click(within(policy).getByRole("button", { name: /detach policy/i }));
    expect(within(policy).getByText(/no policy approval required/i)).toBeDefined();
    fireEvent.click(within(policy).getByRole("button", { name: /approve detach with passkey/i }));
    await waitFor(() =>
      expect(revokeSigner).toHaveBeenCalledWith({ kind: "Policy", value: "CPOLICY" }),
    );
  });

  it("a dismissed passkey prompt changes nothing and says so", async () => {
    const cancelled = Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
    revokeSigner.mockRejectedValue(cancelled);
    renderSettings();
    const device = await screen.findByTestId("signer-device-session");
    fireEvent.click(within(device).getByRole("button", { name: /revoke device session/i }));
    fireEvent.click(within(device).getByRole("button", { name: /approve revoke with passkey/i }));
    expect((await within(device).findByRole("alert")).textContent).toMatch(/nothing was changed/i);
  });
});

describe("Settings — add a second passkey (#401)", () => {
  it("registers, then the existing passkey approves; the list refreshes after confirmation", async () => {
    addPasskey.mockResolvedValue({ hash: "addtx", keyId: "cred-new" });
    renderSettings();
    fireEvent.change(await screen.findByLabelText(/label for the new passkey/i), {
      target: { value: "Phone" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /add passkey — approve with existing passkey/i }),
    );
    await waitFor(() => expect(addPasskey).toHaveBeenCalledWith("Phone"));
    expect(await screen.findByText(/new passkey added on-chain/i)).toBeDefined();
    expect(trackMock).toHaveBeenCalledWith("addtx");
  });

  it("maps a duplicate-signer rejection and a cancelled ceremony to clear errors", async () => {
    addPasskey.mockRejectedValueOnce(new Error("Error(Contract, #101)"));
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: /add passkey — approve/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already exists/i);

    addPasskey.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    fireEvent.click(screen.getByRole("button", { name: /add passkey — approve/i }));
    await waitFor(() =>
      expect(screen.getAllByRole("alert").some((a) => /dismissed/i.test(a.textContent ?? ""))).toBe(
        true,
      ),
    );
  });
});

describe("Settings — agent keys (#394)", () => {
  function happyMint() {
    generateAgentKeyMock.mockResolvedValue({ publicKey: "GAGENTNEW", secret: "SAGENTSECRET" });
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    generateMock.mockResolvedValue({ id: "pol-1" });
    simulateMock.mockResolvedValue({ ok: true });
    deployInstanceMock.mockResolvedValue({ contractId: "CBUDGET" });
    recordMock.mockResolvedValue({});
    const attachPolicy = vi.fn(async () => ({ hash: "attachtx" }));
    const addAgentKey = vi.fn(async () => ({ hash: "addtx" }));
    runtimeMock.mockResolvedValue({ resume: vi.fn(), attachPolicy, addAgentKey });
    return { attachPolicy, addAgentKey };
  }

  it("mints end to end: budget policy deployed, passkey attach, passkey add-signer, one-time secret reveal", async () => {
    const { attachPolicy, addAgentKey } = happyMint();
    renderSettings();
    expect((await screen.findByTestId("agent-network-badge")).textContent).toMatch(/testnet/i);
    fireEvent.change(screen.getByLabelText(/budget \(XLM\) per window/i), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: /mint agent key/i }));

    expect(await screen.findByTestId("mint-success")).toBeDefined();
    // The policy definition sent to the service is the token-scoped budget in base units.
    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "token_spending_limit",
        tokenBudget: { token: "CNATIVE", amountBaseUnits: "100000000", windowSeconds: 86_400 },
      }),
    );
    expect(deployInstanceMock).toHaveBeenCalledWith("pol-1", "CACCOUNT");
    expect(attachPolicy).toHaveBeenCalledWith("CBUDGET");
    // The agent signer names the deployed policy as a required co-signer on the token.
    expect(addAgentKey).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: "GAGENTNEW",
        grants: [{ token: "CNATIVE", policies: ["CBUDGET"] }],
        store: "persistent",
      }),
    );
    expect(trackMock).toHaveBeenCalledWith("attachtx");
    expect(trackMock).toHaveBeenCalledWith("addtx");
    expect(invalidateSigners).toHaveBeenCalled();

    // One-time reveal: shown once, gone after dismiss, never re-shown.
    expect(screen.getByTestId("agent-secret").textContent).toBe("SAGENTSECRET");
    fireEvent.click(screen.getByRole("button", { name: /dismiss forever/i }));
    expect(screen.queryByTestId("agent-secret")).toBeNull();
    expect(screen.getByTestId("secret-dismissed")).toBeDefined();
  });

  it("names an attached provenance policy as a second required co-signer (#398 composition)", async () => {
    window.localStorage.setItem(
      "vellar.provenance.CACCOUNT",
      JSON.stringify({ mode: "strict", policyContractId: "CPOLICY" }),
    );
    const { addAgentKey } = happyMint();
    renderSettings();
    expect(await screen.findByTestId("provenance-cosigner")).toBeDefined();
    fireEvent.change(screen.getByLabelText(/budget \(XLM\) per window/i), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /mint agent key/i }));
    await screen.findByTestId("mint-success");
    expect(addAgentKey).toHaveBeenCalledWith(
      expect.objectContaining({ grants: [{ token: "CNATIVE", policies: ["CBUDGET", "CPOLICY"] }] }),
    );
  });

  it("explains the tumbling-window budget semantics honestly before minting", async () => {
    renderSettings();
    const copy = (await screen.findByTestId("budget-semantics")).textContent ?? "";
    expect(copy).toMatch(/fixed \(tumbling\) period/i);
    expect(copy).toMatch(/twice the budget/i);
    expect(copy).toMatch(/only\s+for this token/i);
    expect(copy).toMatch(/client-side/i);
  });

  it("a refused passkey approval fails the mint without adding the signer", async () => {
    happyMint();
    runtimeMock.mockResolvedValue({
      resume: vi.fn(),
      attachPolicy: vi.fn(async () => {
        throw Object.assign(new Error("x"), { name: "NotAllowedError" });
      }),
      addAgentKey: vi.fn(),
    });
    renderSettings();
    fireEvent.change(await screen.findByLabelText(/budget \(XLM\) per window/i), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: /mint agent key/i }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((a) => /attaching the policy.*dismissed/i.test(a.textContent ?? "")),
      ).toBe(true),
    );
    expect(screen.queryByTestId("agent-secret")).toBeNull();
  });

  it("refuses to mint on mainnet (testnet-only gate)", async () => {
    window.localStorage.setItem(
      "vellar.session",
      JSON.stringify({ ...walletSession, network: "mainnet" }),
    );
    renderSettings();
    expect((await screen.findByTestId("agent-network-badge")).textContent).toMatch(
      /not available/i,
    );
    expect(screen.queryByRole("button", { name: /mint agent key/i })).toBeNull();
    expect(
      screen.getAllByRole("alert").some((a) => /testnet-only/i.test(a.textContent ?? "")),
    ).toBe(true);
  });
});

describe("Settings — verified provenance signing (#398)", () => {
  it("warn mode is a client preference; copy says provenance, not safety", async () => {
    renderSettings();
    const group = await screen.findByRole("radiogroup", { name: /provenance mode/i });
    fireEvent.click(within(group).getByLabelText(/^warn/i));
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    expect(JSON.parse(window.localStorage.getItem("vellar.provenance.CACCOUNT")!)).toEqual({
      mode: "warn",
    });
    const section = screen.getByRole("region", { name: /verified provenance signing/i });
    expect(section.textContent).toMatch(/does not mean audited, benign/i);
    expect(deployInstanceMock).not.toHaveBeenCalled();
  });

  it("strict mode deploys and passkey-attaches the verified_only policy, then reads it back from chain", async () => {
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    generateMock.mockResolvedValue({ id: "pol-prov" });
    simulateMock.mockResolvedValue({ ok: true });
    deployInstanceMock.mockResolvedValue({ contractId: "CPOLICY" });
    recordMock.mockResolvedValue({});
    const attachPolicy = vi.fn(async () => ({ hash: "provtx" }));
    runtimeMock.mockResolvedValue({ resume: vi.fn(), attachPolicy });
    renderSettings();
    const group = await screen.findByRole("radiogroup", { name: /provenance mode/i });
    fireEvent.click(within(group).getByLabelText(/^strict/i));
    fireEvent.click(screen.getByRole("button", { name: /deploy & attach policy/i }));
    expect(await screen.findByText(/policy CPOLICY attached/i)).toBeDefined();
    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "verified_only", provenance: { mode: "strict" } }),
    );
    expect(attachPolicy).toHaveBeenCalledWith("CPOLICY");
    // The preference records the instance; the signer list (chain) confirms it.
    expect(screen.getByTestId("provenance-policy").textContent).toMatch(/confirmed on-chain/);
  });

  it("trusted publishers mode sends the publisher set, not a hash list", async () => {
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    generateMock.mockResolvedValue({ id: "pol-prov" });
    simulateMock.mockResolvedValue({ ok: true });
    deployInstanceMock.mockResolvedValue({ contractId: "CPOLICY" });
    recordMock.mockResolvedValue({});
    runtimeMock.mockResolvedValue({
      resume: vi.fn(),
      attachPolicy: vi.fn(async () => ({ hash: "t" })),
    });
    renderSettings();
    const group = await screen.findByRole("radiogroup", { name: /provenance mode/i });
    fireEvent.click(within(group).getByLabelText(/trusted publishers only/i));
    fireEvent.change(screen.getByLabelText(/trusted publishers \(one per line/i), {
      target: { value: "github.com/vellar-wallet\ngithub.com/acme" },
    });
    fireEvent.click(screen.getByRole("button", { name: /deploy & attach policy/i }));
    await waitFor(() =>
      expect(validateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provenance: {
            mode: "trusted_publishers",
            trustedPublishers: ["github.com/vellar-wallet", "github.com/acme"],
          },
        }),
      ),
    );
  });

  it("flags lost on-chain enforcement when the policy was detached elsewhere (recovery stays reachable)", async () => {
    window.localStorage.setItem(
      "vellar.provenance.CACCOUNT",
      JSON.stringify({ mode: "strict", policyContractId: "CGONE" }),
    );
    renderSettings();
    expect((await screen.findByTestId("provenance-lost")).textContent).toMatch(
      /no longer attached/i,
    );
  });
});

describe("Settings — sessions (unchanged)", () => {
  it("revoking this device signs out and redirects", async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke & sign out" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith("sess-current"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app"));
    expect(window.localStorage.getItem("vellar.session")).toBeNull();
  });

  it("redirects to onboarding when disconnected", async () => {
    window.localStorage.clear();
    renderSettings();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app"));
  });
});
