import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorInitError } from "./connector-factory";

/**
 * Fallback path of the connector factory (#566, #845).
 *
 * passkey-kit is the only connector there is, so "the fallback also failed to initialize" means
 * every way of bringing a connector up has failed. The user must then get ONE error that says no
 * connection method is available and why, not a pair of failure messages, and not a silent dead
 * end. Each test loads a fresh copy of the module so the cached runtime promise cannot leak
 * between cases.
 */

vi.mock("./config", () => ({
  walletConfig: () => ({
    rpcUrl: "https://rpc.example.test",
    networkPassphrase: "Test SDF Network ; September 2015",
    walletWasmHash: "wasm-hash",
    apiUrl: "https://api.example.test",
    network: "testnet",
    appName: "test-app",
  }),
}));
vi.mock("./http-backend", () => ({ createHttpWalletBackend: () => ({}) }));
vi.mock("./server-session", () => ({
  ensureServerSession: (session: unknown) => Promise.resolve(session),
}));
vi.mock("./swap/client", () => ({ createSwapClient: () => ({}) }));
vi.mock("./swap/soroswap", () => ({ createSoroswapVenue: () => ({}) }));
vi.mock("./policy-signer", () => ({ createPolicySignerActions: () => ({}) }));
vi.mock("./wallet-upgrade", () => ({ createWalletUpgradeActions: () => ({}) }));
vi.mock("./signer-actions", () => ({ createSignerActions: () => ({}) }));

const kitCtor = vi.fn();
const sacCtor = vi.fn();
const connectorFactory = vi.fn();
const paymentFactory = vi.fn();

function workingKit() {
  return { sign: vi.fn(), createKey: vi.fn(), remove: vi.fn(), upgrade: vi.fn() };
}

async function load() {
  vi.resetModules();
  vi.doMock("passkey-kit", () => ({ PasskeyKit: kitCtor, SACClient: sacCtor }));
  vi.doMock("vellar-sdk", () => ({
    createPasskeyKitConnector: connectorFactory,
    createPaymentClient: paymentFactory,
    defaultSignedToXdr: () => "",
    resumeKitConnection: () => Promise.resolve(),
  }));
  vi.doMock("vellar-sdk/rpc", () => ({ isValidStellarAddress: () => true }));
  return import("./connector-factory");
}

async function failure(promise: Promise<unknown>): Promise<ConnectorInitError> {
  try {
    await promise;
  } catch (error) {
    return error as ConnectorInitError;
  }
  throw new Error("expected the promise to reject");
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

beforeEach(() => {
  kitCtor.mockReset().mockImplementation(workingKit);
  sacCtor.mockReset().mockImplementation(() => ({}));
  connectorFactory.mockReset().mockReturnValue({ connectWallet: vi.fn(), createWallet: vi.fn() });
  paymentFactory.mockReset().mockReturnValue({});
});

afterEach(() => {
  vi.doUnmock("passkey-kit");
  vi.doUnmock("vellar-sdk");
  vi.doUnmock("vellar-sdk/rpc");
});

describe("no connector can be initialized", () => {
  it("rejects with one ConnectorInitError that names the connector and says nothing is left", async () => {
    kitCtor.mockImplementation(() => {
      throw new Error("WebAuthn is not supported");
    });
    const { getWalletRuntime } = await load();

    const error = await failure(getWalletRuntime());

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConnectorInitError");
    expect(error.code).toBe("INIT_FAILED");
    expect(error.preferredConnector).toBe("passkey-kit");
    expect(error.message).toContain("WebAuthn is not supported");
    expect(error.message).toContain("No fallback connector available");
  });

  it("is a single message: the reason and the dead end each appear once", async () => {
    kitCtor.mockImplementation(() => {
      throw new Error("kit blew up");
    });
    const { getWalletRuntime } = await load();

    const { message } = await failure(getWalletRuntime());

    expect(count(message, "kit blew up")).toBe(1);
    expect(count(message, "No fallback connector available")).toBe(1);
    expect(count(message, "Failed to initialize")).toBe(1);
    expect(message.trim().split(/\.\s/).length).toBeLessThanOrEqual(2);
  });

  it("does not claim a fallback exists or leave a cause chain behind", async () => {
    kitCtor.mockImplementation(() => {
      throw new Error("kit blew up");
    });
    const { getWalletRuntime } = await load();

    const error = await failure(getWalletRuntime());

    expect(error.fallbackConnector).toBeUndefined();
    expect("fallbackConnector" in error).toBe(false);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it.each([
    ["the PasskeyKit constructor throws", () => kitCtor.mockImplementation(() => { throw new Error("kit ctor"); })],
    ["the SAC client constructor throws", () => sacCtor.mockImplementation(() => { throw new Error("sac ctor"); })],
    ["the connector cannot be built", () => connectorFactory.mockImplementation(() => { throw new Error("connector build"); })],
    ["the payment client cannot be built", () => paymentFactory.mockImplementation(() => { throw new Error("payment build"); })],
  ])("gives the same single error shape when %s", async (_label, arrange) => {
    arrange();
    const { getWalletRuntime } = await load();

    const error = await failure(getWalletRuntime());

    expect(error).toMatchObject({
      name: "ConnectorInitError",
      code: "INIT_FAILED",
      preferredConnector: "passkey-kit",
    });
    expect(count(error.message, "No fallback connector available")).toBe(1);
    expect(count(error.message, "Failed to initialize")).toBe(1);
  });

  it("reports a module that fails to load the same way", async () => {
    vi.resetModules();
    vi.doMock("passkey-kit", () => {
      throw new Error("chunk failed to load");
    });
    vi.doMock("vellar-sdk", () => ({
      createPasskeyKitConnector: connectorFactory,
      createPaymentClient: paymentFactory,
      defaultSignedToXdr: () => "",
      resumeKitConnection: () => Promise.resolve(),
    }));
    vi.doMock("vellar-sdk/rpc", () => ({ isValidStellarAddress: () => true }));
    const { getWalletRuntime } = await import("./connector-factory");

    const error = await failure(getWalletRuntime());

    // vitest wraps a throwing mock factory, so the original text is not asserted here.
    expect(error.code).toBe("INIT_FAILED");
    expect(error.preferredConnector).toBe("passkey-kit");
    expect(count(error.message, "No fallback connector available")).toBe(1);
  });

  it("copes with a thrown value that is not an Error", async () => {
    kitCtor.mockImplementation(() => {
      throw "plain string failure";
    });
    const { getWalletRuntime } = await load();

    const error = await failure(getWalletRuntime());

    expect(error.code).toBe("INIT_FAILED");
    expect(error.message).toContain("plain string failure");
    expect(error.message).not.toContain("[object Object]");
  });
});

describe("a failed initialization is not retried behind the user's back", () => {
  it("returns the same rejected promise, and the same error, on every later call", async () => {
    kitCtor.mockImplementation(() => {
      throw new Error("kit blew up");
    });
    const { getWalletRuntime } = await load();

    const first = getWalletRuntime();
    const second = getWalletRuntime();
    const firstError = await failure(first);
    const secondError = await failure(second);

    expect(second).toBe(first);
    expect(secondError).toBe(firstError);
    expect(kitCtor).toHaveBeenCalledTimes(1);
  });

  it("surfaces the one error through every helper instead of a second, different one", async () => {
    kitCtor.mockImplementation(() => {
      throw new Error("kit blew up");
    });
    const { getWalletRuntime, createRealConnector, getRealPaymentClient, getRealSwapClient } =
      await load();

    const base = await failure(getWalletRuntime());

    for (const attempt of [
      createRealConnector(),
      getRealPaymentClient(undefined),
      getRealSwapClient("key-1"),
    ]) {
      const error = await failure(attempt);
      expect(error).toBe(base);
    }
    expect(kitCtor).toHaveBeenCalledTimes(1);
  });

  it("never reaches resume or the payment client when initialization failed", async () => {
    kitCtor.mockImplementation(() => {
      throw new Error("kit blew up");
    });
    const { getRealPaymentClient } = await load();

    await failure(getRealPaymentClient("key-1"));

    expect(paymentFactory).not.toHaveBeenCalled();
  });
});

describe("the runtime failure path also stays a single message", () => {
  it("wraps a connectWallet failure once, with the same dead-end wording", async () => {
    const inner = {
      connectWallet: vi.fn().mockRejectedValue(new Error("user cancelled the prompt")),
      createWallet: vi.fn(),
    };
    connectorFactory.mockReturnValue(inner);
    const { getWalletRuntime } = await load();
    const runtime = await getWalletRuntime();

    const error = await failure(runtime.connector.connectWallet("testnet"));

    expect(error.code).toBe("NO_FALLBACK");
    expect(error.preferredConnector).toBe("passkey-kit");
    expect(count(error.message, "user cancelled the prompt")).toBe(1);
    expect(count(error.message, "No fallback connector available")).toBe(1);
  });

  it("does not stack a second wrapper when connectWallet then createWallet both fail", async () => {
    const inner = {
      connectWallet: vi.fn().mockRejectedValue(new Error("first failure")),
      createWallet: vi.fn().mockRejectedValue(new Error("second failure")),
    };
    connectorFactory.mockReturnValue(inner);
    const { getWalletRuntime } = await load();
    const runtime = await getWalletRuntime();

    const first = await failure(runtime.connector.connectWallet("testnet"));
    const second = await failure(
      runtime.connector.createWallet({ userName: "ada" } as never),
    );

    expect(first.message).toContain("connectWallet");
    expect(second.message).toContain("createWallet");
    expect(second.message).not.toContain("first failure");
    expect(first.message).not.toContain("second failure");
  });
});
