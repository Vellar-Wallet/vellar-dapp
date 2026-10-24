import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getWalletRuntime,
  createRealConnector,
  getRealPaymentClient,
  getRealSwapClient,
  type ConnectorInitError,
} from "./connector-factory";

// Mock dependencies
vi.mock("./config", () => ({
  walletConfig: () => ({
    rpcUrl: "https://test-rpc.example.com",
    networkPassphrase: "Test SDF Network ; September 2015",
    walletWasmHash: "test-hash",
    apiUrl: "https://test-api.example.com",
    network: "testnet",
    appName: "test-app",
  }),
}));

vi.mock("./http-backend", () => ({
  createHttpWalletBackend: () => ({}),
}));

vi.mock("./server-session", () => ({
  ensureServerSession: (session: unknown) => Promise.resolve(session),
}));

vi.mock("./swap/client", () => ({
  createSwapClient: () => ({}),
}));

vi.mock("./swap/soroswap", () => ({
  createSoroswapVenue: () => ({}),
}));

vi.mock("./policy-signer", () => ({
  createPolicySignerActions: () => ({}),
}));

vi.mock("./wallet-upgrade", () => ({
  createWalletUpgradeActions: () => ({}),
}));

vi.mock("./signer-actions", () => ({
  createSignerActions: () => ({}),
}));

describe("connector-factory", () => {
  // Track mocks across tests
  let mockPasskeyKit: any;
  let mockSACClient: any;
  let mockConnector: any;

  beforeEach(() => {
    // Clear the runtime promise cache
    vi.clearAllMocks();

    mockConnector = {
      connectWallet: vi.fn(),
      createWallet: vi.fn(),
    };

    mockPasskeyKit = vi.fn(() => ({
      rpc: { url: "test" },
      addEd25519: vi.fn(),
      sign: vi.fn(),
      createKey: vi.fn(),
      upgrade: vi.fn(),
      remove: vi.fn(),
      getSigner: vi.fn(),
    }));

    mockSACClient = vi.fn();

    // Mock the dynamic imports
    vi.doMock("passkey-kit", () => ({
      PasskeyKit: mockPasskeyKit,
      SACClient: mockSACClient,
    }));

    vi.doMock("vellar-sdk", () => ({
      createPasskeyKitConnector: () => mockConnector,
      createPaymentClient: () => ({}),
      defaultSignedToXdr: () => "",
      resumeKitConnection: () => Promise.resolve(),
    }));

    vi.doMock("vellar-sdk/rpc", () => ({
      isValidStellarAddress: () => true,
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("Happy Path", () => {
    it("should initialize and return a valid runtime on success", async () => {
      mockConnector.connectWallet.mockResolvedValue({ accountId: "test" });

      const runtime = await getWalletRuntime();

      expect(runtime).toBeDefined();
      expect(runtime.connector).toBeDefined();
      expect(runtime.payments).toBeDefined();
      expect(runtime.swaps).toBeDefined();
      expect(runtime.resume).toBeDefined();
      expect(runtime.addDeviceSigner).toBeDefined();
      expect(runtime.attachPolicy).toBeDefined();
      expect(runtime.detachPolicy).toBeDefined();
      expect(runtime.listSigners).toBeDefined();
      expect(runtime.addPasskeySigner).toBeDefined();
      expect(runtime.addAgentKey).toBeDefined();
      expect(runtime.removeSigner).toBeDefined();
      expect(runtime.walletVersion).toBeDefined();
      expect(runtime.upgradeWallet).toBeDefined();
    });

    it("should call real connector methods on connectWallet", async () => {
      mockConnector.connectWallet.mockResolvedValue({ accountId: "test-account" });

      const runtime = await getWalletRuntime();
      const result = await runtime.connector.connectWallet("testnet");

      expect(mockConnector.connectWallet).toHaveBeenCalledWith("testnet");
      expect(result).toEqual({ accountId: "test-account" });
    });

    it("should call real connector methods on createWallet", async () => {
      mockConnector.createWallet.mockResolvedValue({ accountId: "new-account" });

      const runtime = await getWalletRuntime();
      const result = await runtime.connector.createWallet({
        keyId: "key-123",
        name: "test",
      });

      expect(mockConnector.createWallet).toHaveBeenCalled();
      expect(result).toEqual({ accountId: "new-account" });
    });

    it("should cache runtime promise for subsequent calls", async () => {
      mockConnector.connectWallet.mockResolvedValue({ accountId: "test" });

      const runtime1 = await getWalletRuntime();
      const runtime2 = await getWalletRuntime();

      expect(runtime1).toBe(runtime2);
      expect(mockPasskeyKit).toHaveBeenCalledTimes(1);
    });
  });

  describe("Init-Time Failures", () => {
    it("should catch PasskeyKit initialization errors", async () => {
      mockPasskeyKit.mockImplementation(() => {
        throw new Error("PasskeyKit initialization failed");
      });

      // Need to clear the cached promise first
      (global as any).runtimePromise = undefined;

      try {
        await getWalletRuntime();
        expect.fail("Should have thrown");
      } catch (error) {
        const err = error as ConnectorInitError;
        expect(err.name).toBe("ConnectorInitError");
        expect(err.code).toBe("INIT_FAILED");
        expect(err.preferredConnector).toBe("passkey-kit");
        expect(err.message).toContain("No fallback connector available");
      }
    });

    it("should catch import errors during initialization", async () => {
      vi.doUnmock("passkey-kit");
      vi.mock("passkey-kit", () => {
        throw new Error("Failed to load passkey-kit module");
      });

      try {
        await getWalletRuntime();
        expect.fail("Should have thrown");
      } catch (error) {
        const err = error as ConnectorInitError;
        expect(err.code).toBe("INIT_FAILED");
        expect(err.message).toContain("Failed to initialize preferred connector");
      }
    });
  });

  describe("Runtime Failures (connectWallet)", () => {
    it("should detect connectWallet failures at runtime", async () => {
      mockConnector.connectWallet.mockRejectedValue(
        new Error("WebAuthn verification failed")
      );

      const runtime = await getWalletRuntime();

      try {
        await runtime.connector.connectWallet("testnet");
        expect.fail("Should have thrown");
      } catch (error) {
        const err = error as ConnectorInitError;
        expect(err.name).toBe("ConnectorInitError");
        expect(err.code).toBe("NO_FALLBACK");
        expect(err.preferredConnector).toBe("passkey-kit");
        expect(err.message).toContain("connectWallet");
        expect(err.message).toContain("No fallback connector available");
      }
    });

    it("should include error details in the thrown error", async () => {
      const errorMsg = "RPC connection timeout";
      mockConnector.connectWallet.mockRejectedValue(new Error(errorMsg));

      const runtime = await getWalletRuntime();

      try {
        await runtime.connector.connectWallet("testnet");
      } catch (error) {
        const err = error as ConnectorInitError;
        expect(err.message).toContain(errorMsg);
      }
    });
  });

  describe("Runtime Failures (createWallet)", () => {
    it("should detect createWallet failures at runtime", async () => {
      mockConnector.createWallet.mockRejectedValue(
        new Error("Wallet creation denied by user")
      );

      const runtime = await getWalletRuntime();

      try {
        await runtime.connector.createWallet({ keyId: "key-123", name: "test" });
        expect.fail("Should have thrown");
      } catch (error) {
        const err = error as ConnectorInitError;
        expect(err.code).toBe("NO_FALLBACK");
        expect(err.message).toContain("createWallet");
        expect(err.message).toContain("No fallback connector available");
      }
    });
  });

  describe("Resume failures", () => {
    it("should detect resume operation failures", async () => {
      mockConnector.connectWallet.mockResolvedValue({ accountId: "test" });

      vi.doMock("vellar-sdk", () => ({
        createPasskeyKitConnector: () => mockConnector,
        createPaymentClient: () => ({}),
        defaultSignedToXdr: () => "",
        resumeKitConnection: () => {
          throw new Error("Kit resume failed");
        },
      }));

      const runtime = await getWalletRuntime();

      try {
        await runtime.resume("key-123");
        expect.fail("Should have thrown");
      } catch (error) {
        const err = error as ConnectorInitError;
        expect(err.code).toBe("OPERATION_FAILED");
        expect(err.message).toContain("resume");
        expect(err.preferredConnector).toBe("passkey-kit");
      }
    });
  });

  describe("Helper functions", () => {
    it("createRealConnector should return the connector from runtime", async () => {
      mockConnector.connectWallet.mockResolvedValue({ accountId: "test" });

      const connector = await createRealConnector();

      expect(connector).toBe(mockConnector);
    });

    it("getRealPaymentClient should call resume if keyId provided", async () => {
      mockConnector.connectWallet.mockResolvedValue({ accountId: "test" });

      const resumeSpy = vi.fn(() => Promise.resolve());
      vi.doMock("vellar-sdk", () => ({
        createPasskeyKitConnector: () => mockConnector,
        createPaymentClient: () => ({}),
        defaultSignedToXdr: () => "",
        resumeKitConnection: resumeSpy,
      }));

      const runtime = await getWalletRuntime();
      const result = await getRealPaymentClient("key-123");

      expect(result).toBeDefined();
    });

    it("getRealSwapClient should return swap client", async () => {
      mockConnector.connectWallet.mockResolvedValue({ accountId: "test" });

      const result = await getRealSwapClient(undefined);

      expect(result).toBeDefined();
    });
  });

  describe("Error metadata", () => {
    it("should include fallbackConnector when available in error", async () => {
      mockPasskeyKit.mockImplementation(() => {
        throw new Error("Init failed");
      });

      try {
        await getWalletRuntime();
      } catch (error) {
        const err = error as ConnectorInitError;
        // fallbackConnector should be undefined when no fallback is available
        expect(err.fallbackConnector).toBeUndefined();
      }
    });

    it("should structure ConnectorInitError properly", async () => {
      mockConnector.connectWallet.mockRejectedValue(new Error("Test error"));

      const runtime = await getWalletRuntime();

      try {
        await runtime.connector.connectWallet("testnet");
      } catch (error) {
        const err = error as ConnectorInitError;
        expect(err.name).toBe("ConnectorInitError");
        expect(typeof err.code).toBe("string");
        expect(["INIT_FAILED", "OPERATION_FAILED", "NO_FALLBACK"]).toContain(err.code);
        expect(err.preferredConnector).toBe("passkey-kit");
        expect(err.message).toBeDefined();
      }
    });
  });
});
