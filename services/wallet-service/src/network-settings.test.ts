import { readFileSync } from "node:fs";
import { NetworkConfigError } from "@vellar/service-kit";
import { describe, expect, it, vi } from "vitest";
import {
  assertRpcMatchesPassphrase,
  networkSettingsFromEnv,
  RpcNetworkMismatchError,
  RpcUnreachableError,
  verifyRpcAtBoot,
} from "./network-settings";

// One trusted RPC + passphrase for the configured network (security-audit.md
// RA-10 class, PR #736 review). Every consumer in index.ts (scoping passphrase,
// budget label, ledger lookup, sponsor submitter, relayer) must read the SAME
// values, resolved from STELLAR_NETWORK, never from `relayer?.x ?? testnet`.

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const MAINNET_RPC = "https://mainnet.sorobanrpc.com";

describe("networkSettingsFromEnv", () => {
  it("mainnet with NO relayer and no overrides uses the MAINNET defaults, never testnet", () => {
    // The review's scenario: a sponsor-only mainnet service (no RELAYER_* set).
    const s = networkSettingsFromEnv({ STELLAR_NETWORK: "mainnet" });
    expect(s).toEqual({
      network: "mainnet",
      rpcUrl: MAINNET_RPC,
      networkPassphrase: MAINNET_PASSPHRASE,
    });
  });

  it("testnet with nothing else set uses the testnet defaults", () => {
    expect(networkSettingsFromEnv({ STELLAR_NETWORK: "testnet" })).toEqual({
      network: "testnet",
      rpcUrl: TESTNET_RPC,
      networkPassphrase: TESTNET_PASSPHRASE,
    });
  });

  it("STELLAR_RPC_URL wins over the per-network default, relayer or not", () => {
    const s = networkSettingsFromEnv({
      STELLAR_NETWORK: "mainnet",
      STELLAR_RPC_URL: "https://soroban-rpc.mainnet.stellar.gateway.fm",
    });
    expect(s.rpcUrl).toBe("https://soroban-rpc.mainnet.stellar.gateway.fm");
  });

  it("STELLAR_NETWORK_PASSPHRASE is honoured when it agrees with the network", () => {
    const s = networkSettingsFromEnv({
      STELLAR_NETWORK: "mainnet",
      STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
    });
    expect(s.networkPassphrase).toBe(MAINNET_PASSPHRASE);
  });

  it("treats blank overrides as unset", () => {
    const s = networkSettingsFromEnv({
      STELLAR_NETWORK: "mainnet",
      STELLAR_RPC_URL: "  ",
      STELLAR_NETWORK_PASSPHRASE: "",
    });
    expect(s.rpcUrl).toBe(MAINNET_RPC);
    expect(s.networkPassphrase).toBe(MAINNET_PASSPHRASE);
  });

  it("an unset STELLAR_NETWORK fails closed; it never falls back to testnet", () => {
    expect(() => networkSettingsFromEnv({})).toThrow(NetworkConfigError);
    expect(() => networkSettingsFromEnv({ STELLAR_RPC_URL: TESTNET_RPC })).toThrow(
      /STELLAR_NETWORK is not set/,
    );
  });

  it("an unknown STELLAR_NETWORK fails closed", () => {
    expect(() => networkSettingsFromEnv({ STELLAR_NETWORK: "devnet" })).toThrow(NetworkConfigError);
  });

  it("refuses mainnet with a testnet passphrase (names the disagreement)", () => {
    expect(() =>
      networkSettingsFromEnv({
        STELLAR_NETWORK: "mainnet",
        STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
      }),
    ).toThrow(/passphrase looks like testnet/);
  });

  it("refuses mainnet with a testnet RPC", () => {
    expect(() =>
      networkSettingsFromEnv({ STELLAR_NETWORK: "mainnet", STELLAR_RPC_URL: TESTNET_RPC }),
    ).toThrow(/RPC host looks like testnet/);
  });

  it("refuses testnet with a mainnet RPC", () => {
    expect(() =>
      networkSettingsFromEnv({ STELLAR_NETWORK: "testnet", STELLAR_RPC_URL: MAINNET_RPC }),
    ).toThrow(/RPC host looks like mainnet/);
  });

  it("refuses an unrecognised passphrase", () => {
    expect(() =>
      networkSettingsFromEnv({
        STELLAR_NETWORK: "testnet",
        STELLAR_NETWORK_PASSPHRASE: "Some Private Network",
      }),
    ).toThrow(/unrecognized/);
  });
});

describe("assertRpcMatchesPassphrase", () => {
  const rpcAnswering = (passphrase: string) => ({ getNetwork: async () => ({ passphrase }) });
  const noSleep = { delayMs: 0 };

  it("passes when the RPC reports the configured passphrase", async () => {
    await expect(
      assertRpcMatchesPassphrase(rpcAnswering(MAINNET_PASSPHRASE), MAINNET_PASSPHRASE, noSleep),
    ).resolves.toBeUndefined();
  });

  it("a mainnet config against a TESTNET rpc fails the boot, naming both passphrases", async () => {
    const err = await assertRpcMatchesPassphrase(
      rpcAnswering(TESTNET_PASSPHRASE),
      MAINNET_PASSPHRASE,
      noSleep,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RpcNetworkMismatchError);
    expect((err as Error).message).toContain(MAINNET_PASSPHRASE);
    expect((err as Error).message).toContain(TESTNET_PASSPHRASE);
  });

  it("a testnet config against a MAINNET rpc fails too", async () => {
    await expect(
      assertRpcMatchesPassphrase(rpcAnswering(MAINNET_PASSPHRASE), TESTNET_PASSPHRASE, noSleep),
    ).rejects.toBeInstanceOf(RpcNetworkMismatchError);
  });

  it("does not retry a mismatch: the answer will not change", async () => {
    const getNetwork = vi.fn(async () => ({ passphrase: TESTNET_PASSPHRASE }));
    await expect(
      assertRpcMatchesPassphrase({ getNetwork }, MAINNET_PASSPHRASE, { attempts: 5, delayMs: 0 }),
    ).rejects.toBeInstanceOf(RpcNetworkMismatchError);
    expect(getNetwork).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds", async () => {
    const getNetwork = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ passphrase: MAINNET_PASSPHRASE });
    await expect(
      assertRpcMatchesPassphrase({ getNetwork }, MAINNET_PASSPHRASE, { attempts: 3, delayMs: 0 }),
    ).resolves.toBeUndefined();
    expect(getNetwork).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured attempts with an unreachable error", async () => {
    const getNetwork = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      assertRpcMatchesPassphrase({ getNetwork }, MAINNET_PASSPHRASE, { attempts: 3, delayMs: 0 }),
    ).rejects.toBeInstanceOf(RpcUnreachableError);
    expect(getNetwork).toHaveBeenCalledTimes(3);
  });

  it("an empty or missing passphrase in the RPC answer is a mismatch, not a pass", async () => {
    await expect(
      assertRpcMatchesPassphrase(rpcAnswering(""), MAINNET_PASSPHRASE, noSleep),
    ).rejects.toBeInstanceOf(RpcNetworkMismatchError);
    await expect(
      assertRpcMatchesPassphrase(
        { getNetwork: async () => ({}) as { passphrase: string } },
        MAINNET_PASSPHRASE,
        noSleep,
      ),
    ).rejects.toBeInstanceOf(RpcNetworkMismatchError);
  });
});

describe("verifyRpcAtBoot", () => {
  const down = { getNetwork: async () => Promise.reject(new Error("ENOTFOUND")) };
  const opts = { attempts: 1, delayMs: 0 };

  it("a passphrase MISMATCH refuses to boot in every environment", async () => {
    const wrong = { getNetwork: async () => ({ passphrase: TESTNET_PASSPHRASE }) };
    for (const production of [true, false]) {
      await expect(
        verifyRpcAtBoot(wrong, MAINNET_PASSPHRASE, { production, warn: () => {}, ...opts }),
      ).rejects.toBeInstanceOf(RpcNetworkMismatchError);
    }
  });

  it("an UNREACHABLE rpc refuses to boot in production (cannot verify the network)", async () => {
    await expect(
      verifyRpcAtBoot(down, MAINNET_PASSPHRASE, { production: true, warn: () => {}, ...opts }),
    ).rejects.toBeInstanceOf(RpcUnreachableError);
  });

  it("an unreachable rpc only warns outside production so offline local dev still boots", async () => {
    const warn = vi.fn();
    await expect(
      verifyRpcAtBoot(down, TESTNET_PASSPHRASE, { production: false, warn, ...opts }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not verify/i);
  });
});

// index.ts is a top-level-await entrypoint and cannot be imported in a unit
// test. This pins the RA-10-class regression directly: no network setting in it
// may be derived from `relayer?.x ?? DEFAULTS.x` (a testnet default) again.
describe("index.ts reads one resolved network (regression guard)", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("never falls back to DEFAULTS for the rpc url or the passphrase", () => {
    expect(source).not.toMatch(/\?\?\s*DEFAULTS\.(rpcUrl|networkPassphrase)/);
    expect(source).not.toMatch(/relayer\?\.(rpcUrl|networkPassphrase)/);
  });

  it("builds deps.networkPassphrase from the resolved settings", () => {
    expect(source).toMatch(/networkPassphrase:\s*net\.networkPassphrase/);
  });

  it("verifies the RPC against the passphrase at boot", () => {
    expect(source).toMatch(/verifyRpcAtBoot\(/);
  });
});
