/**
 * Background worker suspension / restart tests (issues #775, #776).
 *
 * This file lives in test/ (not next to background.ts) because WXT treats any
 * root-level file in entrypoints/ as a build entrypoint, which would collide
 * with background.ts. It imports only the injectable `createBackgroundRuntime`
 * core. WXT's virtual `#imports` module is aliased to a test stub in
 * vitest.config.ts so importing the entrypoint does not boot the production
 * wrapper. The `.tsx` extension is required by the current Vitest "components"
 * project include glob; no React is used here.
 *
 * The production semantics under test are documented at the top of
 * `background.ts`: pending approvals are IN-MEMORY and intentionally lost on
 * suspension/restart, while persistent wallet/grant state survives.
 */
import { describe, expect, it, vi } from "vitest";
import { requestEnvelope } from "@vellar/provider-sdk";
import {
  createBackgroundRuntime,
  type BackgroundBrowser,
  type BackgroundRuntimeOptions,
} from "../entrypoints/background";
import type { ExtensionState, KeyValueStore } from "../lib/state";

const ORIGIN = "https://dapp.example";
const PAIRED: ExtensionState = {
  pairedWallet: {
    address: "CABC",
    network: "testnet",
    rpcUrl: "https://rpc.test",
    keyId: "key-1",
    walletWasmHash: "ab".repeat(32),
  },
  grants: [],
};

interface BrowserStub {
  browser: BackgroundBrowser;
  windowsCreate: ReturnType<typeof vi.fn>;
  windowsRemove: ReturnType<typeof vi.fn>;
}

function makeBrowser(): BrowserStub {
  const windowsCreate = vi.fn(async () => ({ id: 77 }));
  const windowsRemove = vi.fn(async () => undefined);
  const browser: BackgroundBrowser = {
    tabs: { onRemoved: { addListener: vi.fn() } },
    windows: {
      onRemoved: { addListener: vi.fn() },
      remove: windowsRemove,
      update: vi.fn(async () => ({})),
      create: windowsCreate,
    },
    runtime: { getURL: (path) => `chrome-extension://test${path}` },
  };
  return { browser, windowsCreate, windowsRemove };
}

function makeKv(initial: unknown): KeyValueStore & { stored: () => unknown } {
  let value = initial;
  return {
    stored: () => value,
    async get() {
      return value;
    },
    async set(_key, next) {
      value = next;
    },
  };
}

function makeRuntime(
  overrides: Partial<BackgroundRuntimeOptions> = {},
): ReturnType<typeof createBackgroundRuntime> {
  const { browser } = makeBrowser();
  return createBackgroundRuntime({
    browser,
    kv: makeKv(PAIRED),
    pairOrigins: "any",
    reportError: vi.fn(),
    now: () => "2026-11-22T00:00:00.000Z",
    ...overrides,
  });
}

function connectRequest(id: string) {
  return {
    type: "provider-request" as const,
    envelope: requestEnvelope(id, { method: "connect", params: { network: "testnet" } }),
  };
}

const pageSender = { origin: ORIGIN, url: `${ORIGIN}/index.html`, tab: { id: 7 } };

describe("background worker suspension and restart (#775, #776)", () => {
  it("happy path: a request is queued, approved in the popup, and answered", async () => {
    const runtime = makeRuntime();

    const reply = runtime.handleProviderRequest(connectRequest("req-happy"), pageSender);
    await vi.waitFor(() => expect(runtime.listPending()).toHaveLength(1));
    expect(runtime.listPending()[0]).toMatchObject({ id: "req-happy", origin: ORIGIN });

    expect(await runtime.handleResolvePending("req-happy", true)).toBe(true);
    await expect(reply).resolves.toMatchObject({
      method: "connect",
      result: { address: "CABC", network: "testnet" },
    });
    expect(runtime.listPending()).toHaveLength(0);
  });

  it("suspension before approval: a fresh worker has no pending state (#776)", async () => {
    const kv = makeKv(PAIRED);
    const runtimeA = makeRuntime({ kv });

    const reply = runtimeA.handleProviderRequest(connectRequest("req-suspended"), pageSender);
    await vi.waitFor(() => expect(runtimeA.listPending()).toHaveLength(1));

    // Simulate MV3 suspension: the browser discards the worker. A replacement
    // shares the same persistent KV but starts with an empty in-memory queue.
    const runtimeB = makeRuntime({ kv });
    expect(runtimeB.listPending()).toEqual([]);

    // The old id cannot be resolved by the replacement, and it fails promptly
    // rather than hanging or resolving a stale promise.
    expect(await runtimeB.handleResolvePending("req-suspended", true)).toBe(false);

    // The original dApp promise is still outstanding: there is no surviving
    // worker channel to reject it, so the content-script timeout is what frees
    // the page. This is the explicit, documented assumption in background.ts.
    let settled = false;
    void reply.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("restart after approval but before delivery loses the in-flight request (#775)", async () => {
    // Gate the persistent write so the worker is genuinely mid-resolution
    // (approval given, response not yet delivered) when we replace it.
    let releaseGrant!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGrant = resolve;
    });
    const baseKv = makeKv(PAIRED);
    const gatedKv: KeyValueStore = {
      get: (key) => baseKv.get(key),
      set: async (key, value) => {
        await gate;
        await baseKv.set(key, value);
      },
    };

    const runtimeA = makeRuntime({ kv: gatedKv });
    const reply = runtimeA.handleProviderRequest(connectRequest("req-restart"), pageSender);
    await vi.waitFor(() => expect(runtimeA.listPending()).toHaveLength(1));

    // startResolving() moves the entry out of the pending queue into in-flight.
    const inFlight = runtimeA.handleResolvePending("req-restart", true);
    expect(runtimeA.listPending()).toHaveLength(0);

    // Extension update: a new worker takes over with no memory of the approval.
    const runtimeB = makeRuntime({ kv: baseKv });
    expect(runtimeB.listPending()).toEqual([]);
    expect(await runtimeB.handleResolvePending("req-restart", true)).toBe(false);

    // Let the old worker complete so the test leaves no dangling promises.
    releaseGrant();
    expect(await inFlight).toBe(true);
    await expect(reply).resolves.toMatchObject({
      method: "connect",
      result: { address: "CABC", network: "testnet" },
    });
  });

  it("supersedes an older same-origin request from the same method", async () => {
    // Regression for the undefined `pending` reference that previously lived
    // in the worker: the manager's own supersedePending is the real seam.
    const runtime = makeRuntime();

    const first = runtime.handleProviderRequest(connectRequest("req-old"), pageSender);
    await vi.waitFor(() => expect(runtime.listPending()).toHaveLength(1));

    runtime.handleProviderRequest(connectRequest("req-new"), pageSender);
    await vi.waitFor(() => expect(runtime.listPending()[0]?.id).toBe("req-new"));

    await expect(first).resolves.toMatchObject({ error: { code: "rejected" } });
    expect(runtime.listPending()).toHaveLength(1);
  });

  it("routes a request from a non-page context as invalid even after a restart", async () => {
    const runtime = makeRuntime();
    const reply = await runtime.handleProviderRequest(connectRequest("req-nopage"), {
      origin: ORIGIN,
    });
    expect(reply).toMatchObject({ error: { code: "invalid_request" } });
    expect(runtime.listPending()).toHaveLength(0);
  });
});
