import { describe, expect, it, vi } from "vitest";
import { SignerKey, type WalletSigner } from "passkey-kit";
import { listAgentKeys, revokeAgentKey, type AgentKeyDeps } from "./agent-keys";

function row(overrides: Partial<WalletSigner> = {}): WalletSigner {
  return {
    key: SignerKey.Ed25519("GAGENT"),
    expiration: 2_000,
    limits: new Map([["CTOKEN", [SignerKey.Policy("CPOLICY")]]]),
    storage: "temporary",
    status: "live",
    ...overrides,
  };
}

function deps(signers: WalletSigner[], live = new Set(["GAGENT", "CPOLICY"])) {
  const calls: string[] = [];
  const key = (kind: string, value: string) => ({ kind, value });
  const kit = {
    getSigner: vi.fn(async (value: unknown) =>
      live.has((value as { value: string }).value) ? { found: true } : null,
    ),
    remove: vi.fn(async (value: unknown) => {
      const typed = value as { kind: string; value: string };
      calls.push(`remove:${typed.kind}:${typed.value}`);
      live.delete(typed.value);
      return { toXDR: () => `xdr:${typed.value}` };
    }),
    sign: vi.fn(async (tx: unknown) => {
      calls.push("sign");
      return tx;
    }),
  };
  const backend = {
    submitTransaction: vi.fn(async ({ signedXdr }: { signedXdr: string }) => {
      calls.push(`submit:${signedXdr}`);
      return { hash: `hash-${calls.length}` };
    }),
  };
  return {
    calls,
    deps: {
      indexer: { getSigners: vi.fn(async () => signers) },
      kit,
      backend,
      network: "testnet",
      SignerKey: {
        Ed25519: (value: string) => key("Ed25519", value),
        Policy: (value: string) => key("Policy", value),
      },
      now: () => 1_000_000,
    } as AgentKeyDeps,
  };
}

describe("agent key actions", () => {
  it("lists Ed25519 keys and derives their required policies", async () => {
    const fixture = deps([row()]);
    await expect(listAgentKeys(fixture.deps, "CWALLET")).resolves.toEqual([
      expect.objectContaining({
        publicKey: "GAGENT",
        status: "active",
        boundContracts: ["CTOKEN"],
        policyContractIds: ["CPOLICY"],
      }),
    ]);
  });

  it("treats the wallet contract as authoritative when the indexer is stale", async () => {
    const fixture = deps([row()], new Set());
    const [key] = await listAgentKeys(fixture.deps, "CWALLET");
    expect(key?.status).toBe("revoked");
  });

  it("detaches required policies before removing the key", async () => {
    const fixture = deps([row()]);
    const result = await revokeAgentKey(fixture.deps, "GAGENT", ["CPOLICY"]);
    expect(result.alreadyRevoked).toBe(false);
    expect(fixture.calls).toEqual([
      "remove:Policy:CPOLICY",
      "sign",
      "submit:xdr:CPOLICY",
      "remove:Ed25519:GAGENT",
      "sign",
      "submit:xdr:GAGENT",
    ]);
  });

  it("is idempotent and reports a key already gone", async () => {
    const fixture = deps([row()], new Set());
    await expect(revokeAgentKey(fixture.deps, "GAGENT", ["CPOLICY"])).resolves.toEqual({
      alreadyRevoked: true,
      hashes: [],
    });
    expect(fixture.calls).toEqual([]);
  });
});
