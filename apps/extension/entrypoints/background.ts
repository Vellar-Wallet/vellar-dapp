import { defineBackground } from "wxt/utils/define-background";
import "../lib/buffer-polyfill";
import { browser } from "wxt/browser";
import {
  CONNECT_GRANT_CAPABILITIES,
  errorPayload,
  type ResponsePayload,
} from "@vellar/provider-sdk";
import { browserKv } from "../lib/browser-kv";
import {
  createIdbDeviceKeyStore,
  devicePublicKeyHex,
  ensureDeviceKey,
  type DeviceKeyStore,
} from "../lib/device-key";
import { signTransactionXdr, signAuthEntryXdr, signMessageBytes } from "../lib/tx-signer";
import type {
  ExtensionMessage,
  PendingApprovalSummary,
  ProviderRequestMessage,
} from "../lib/messages";
import { routeProviderRequest } from "../lib/router";
import {
  pairOriginPolicy,
  PairOriginsMisconfiguredError,
  type PairOriginPolicy,
} from "../lib/pair-origins";
import {
  addGrant,
  loadState,
  revokeGrant,
  setPairedWallet,
  type KeyValueStore,
} from "../lib/state";
import { backgroundErrorReporter } from "../lib/error-reporter";

// Background service worker (technical-doc.md §6.2B, §7.3): routes validated
// dApp requests, holds the pending-approval queue, and opens the approval
// popup. The trusted origin comes exclusively from the message sender.

export interface PendingApproval extends PendingApprovalSummary {
  tabId?: number;
  resolve(payload: ResponsePayload): void;
}

export interface BackgroundDeps {
  kv?: KeyValueStore;
  createDeviceKeyStore?: () => DeviceKeyStore;
  ensureDeviceKeyFn?: typeof ensureDeviceKey;
  devicePublicKeyHexFn?: typeof devicePublicKeyHex;
  signTransactionXdrFn?: typeof signTransactionXdr;
  signAuthEntryXdrFn?: typeof signAuthEntryXdr;
  signMessageBytesFn?: typeof signMessageBytes;
  resolvePairOrigins?: () => PairOriginPolicy;
  errorReporter?: {
    reportError(error: unknown, context?: Record<string, unknown>): Promise<unknown>;
  };
  windowsApi?: {
    create(createData: {
      url: string;
      type: "popup";
      width: number;
      height: number;
    }): Promise<{ id?: number } | undefined>;
    update(windowId: number, updateInfo: { focused: boolean }): Promise<unknown>;
    remove?(windowId: number): Promise<void>;
    onRemoved?: { addListener(cb: (windowId: number) => void): void };
  };
  tabsApi?: {
    onRemoved?: { addListener(cb: (tabId: number) => void): void };
  };
  runtimeApi?: {
    getURL(path: string): string;
    onMessage?: {
      addListener(
        cb: (raw: unknown, sender: { origin?: string; url?: string; tab?: unknown }) => unknown,
      ): void;
    };
  };
}

function extractSenderTabId(tab: unknown): number | undefined {
  if (typeof tab !== "object" || tab === null) return undefined;
  const id = (tab as { id?: unknown }).id;
  return typeof id === "number" ? id : undefined;
}

export function createBackgroundController(deps: BackgroundDeps = {}) {
  const kv = deps.kv ?? browserKv;
  const getDeviceKeyStore = deps.createDeviceKeyStore ?? createIdbDeviceKeyStore;
  const ensureDeviceKeyImpl = deps.ensureDeviceKeyFn ?? ensureDeviceKey;
  const devicePublicKeyHexImpl = deps.devicePublicKeyHexFn ?? devicePublicKeyHex;
  const signTransactionXdrImpl = deps.signTransactionXdrFn ?? signTransactionXdr;
  const signAuthEntryXdrImpl = deps.signAuthEntryXdrFn ?? signAuthEntryXdr;
  const signMessageBytesImpl = deps.signMessageBytesFn ?? signMessageBytes;
  const reporter = deps.errorReporter ?? backgroundErrorReporter;
  const windowsApi = deps.windowsApi ?? browser.windows;
  const tabsApi = deps.tabsApi ?? browser.tabs;
  const runtimeApi = deps.runtimeApi ?? browser.runtime;

  const pending = new Map<string, PendingApproval>();
  const resolving = new Map<string, PendingApproval>();
  const abortedRequests = new Set<string>();
  // Track the open approval window so we don't spawn a new one per request.
  let approvalWindowId: number | undefined;
  let openingWindowPromise: Promise<void> | undefined;

  // L3: resolve the pair-origin allowlist once at startup. A misconfigured
  // production build (no origins, no escape hatch) throws — we DISABLE pairing
  // rather than fall back, so an unconfigured prod artifact can never pair with
  // an arbitrary origin. An empty allowlist (`[]`) refuses every `pair`.
  let pairOrigins: PairOriginPolicy;
  try {
    pairOrigins = (deps.resolvePairOrigins ?? pairOriginPolicy)();
    if (pairOrigins === "any") {
      console.warn(
        "[vellar] WXT_PUBLIC_ALLOW_ANY_PAIR_ORIGIN is set — ANY origin may pair the extension. " +
          "Do not ship this in a production build.",
      );
    }
  } catch (err) {
    if (err instanceof PairOriginsMisconfiguredError) {
      console.error(`[vellar] pairing disabled: ${err.message}`);
      void reporter.reportError(err, { source: "pair_origins_misconfigured" });
      pairOrigins = []; // fail closed: no origin may pair
    } else {
      void reporter.reportError(err, { source: "pair_origins_init" });
      throw err;
    }
  }

  windowsApi?.onRemoved?.addListener((closedId) => {
    if (closedId === approvalWindowId) approvalWindowId = undefined;
  });

  function closeApprovalWindowIfIdle(): void {
    if (pending.size === 0 && resolving.size === 0 && approvalWindowId !== undefined) {
      const winId = approvalWindowId;
      approvalWindowId = undefined;
      try {
        void Promise.resolve(windowsApi?.remove?.(winId)).catch(() => {
          // Window may already be closed; ignore cleanup errors.
        });
      } catch {
        // Ignore synchronous errors when closing an already-closed window.
      }
    }
  }

  function handleTabRemoved(closedTabId: number): void {
    let cleanedAny = false;

    for (const [id, entry] of pending) {
      if (entry.tabId === closedTabId) {
        pending.delete(id);
        cleanedAny = true;
        entry.resolve(errorPayload("rejected", "Requesting tab was closed"));
      }
    }

    for (const [id, entry] of resolving) {
      if (entry.tabId === closedTabId) {
        abortedRequests.add(id);
        resolving.delete(id);
        cleanedAny = true;
        entry.resolve(errorPayload("rejected", "Requesting tab was closed"));
      }
    }

    if (cleanedAny) {
      closeApprovalWindowIfIdle();
    }
  }

  tabsApi?.onRemoved?.addListener((closedTabId) => {
    handleTabRemoved(closedTabId);
  });

  async function handleProviderRequest(
    message: ProviderRequestMessage,
    sender: { origin?: string; url?: string; tab?: unknown },
  ): Promise<ResponsePayload> {
    const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
    if (!origin || !sender.tab) {
      return errorPayload("invalid_request", "Request did not come from a page context");
    }
    const tabId = extractSenderTabId(sender.tab);

    const state = await loadState(kv);
    const decision = routeProviderRequest(message.envelope.request, origin, state, pairOrigins);

    if (decision.kind === "respond") {
      if (decision.revokeGrant && state.pairedWallet) {
        await revokeGrant(kv, origin, state.pairedWallet.network);
      }
      return decision.payload;
    }

    // Explicit approval required (§7.3). A newer request from the same
    // origin+method supersedes any earlier still-pending one (e.g. re-clicking
    // "Pair") — settle the old promise so the caller isn't left hanging, and
    // never stack duplicate cards.
    for (const [oldId, entry] of pending) {
      if (
        entry.origin === decision.origin &&
        entry.request.method === message.envelope.request.method
      ) {
        entry.resolve(errorPayload("rejected", "Superseded by a newer request"));
        pending.delete(oldId);
      }
    }

    return new Promise<ResponsePayload>((resolve) => {
      const id = message.envelope.id;
      pending.set(id, {
        id,
        origin: decision.origin,
        request: message.envelope.request,
        tabId,
        resolve,
      });
      void openApprovalWindow();
    });
  }

  async function openApprovalWindow(): Promise<void> {
    if (openingWindowPromise) {
      await openingWindowPromise;
      return;
    }
    openingWindowPromise = (async () => {
      // Reuse an already-open approval window; only create one if none exists.
      if (approvalWindowId !== undefined) {
        try {
          await windowsApi.update(approvalWindowId, { focused: true });
          return;
        } catch {
          approvalWindowId = undefined; // window was gone; fall through to create
        }
      }
      const win = await windowsApi.create({
        url: runtimeApi.getURL("/popup.html?approval=1"),
        type: "popup",
        width: 380,
        height: 600,
      });
      approvalWindowId = win?.id;
      if (pending.size === 0 && resolving.size === 0) {
        closeApprovalWindowIfIdle();
      }
    })();
    try {
      await openingWindowPromise;
    } finally {
      openingWindowPromise = undefined;
    }
  }

  async function handleResolvePending(id: string, approved: boolean): Promise<boolean> {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);

    if (!approved) {
      entry.resolve(errorPayload("rejected", "The user declined the request"));
      return true;
    }

    resolving.set(id, entry);
    const isAborted = () => abortedRequests.has(id);

    try {
      if (entry.request.method === "pair") {
        await handlePairApproval(entry, isAborted);
        return !isAborted();
      }

      const state = await loadState(kv);
      if (isAborted()) return false;

      const wallet = state.pairedWallet;
      if (!wallet) {
        entry.resolve(errorPayload("disconnected", "No wallet is paired"));
        return true;
      }

      if (entry.request.method === "connect") {
        await addGrant(kv, {
          origin: entry.origin,
          accountId: wallet.address,
          network: wallet.network,
          capabilities: [...CONNECT_GRANT_CAPABILITIES],
          grantedAt: new Date().toISOString(),
        });
        if (isAborted()) {
          await revokeGrant(kv, entry.origin, wallet.network);
          return false;
        }
        entry.resolve({
          method: "connect",
          result: { address: wallet.address, network: wallet.network },
        });
        return true;
      }

      if (entry.request.method === "sign_transaction") {
        try {
          const store = getDeviceKeyStore();
          const pair = await store.get();
          if (isAborted()) return false;
          if (!pair) {
            entry.resolve(errorPayload("disconnected", "No device signer — re-pair the extension"));
            return true;
          }
          const rawPublicKey = Uint8Array.from(
            (await devicePublicKeyHexImpl(pair)).match(/../g)!.map((b) => parseInt(b, 16)),
          );
          if (isAborted()) return false;
          const signedXdr = await signTransactionXdrImpl({
            xdr: entry.request.params.xdr,
            wallet,
            deviceKeyPair: pair,
            deviceRawPublicKey: rawPublicKey,
          });
          if (isAborted()) return false;
          entry.resolve({ method: "sign_transaction", result: { signedXdr } });
        } catch (err) {
          if (isAborted()) return false;
          void reporter.reportError(err, {
            method: "sign_transaction",
            origin: entry.origin,
          });
          entry.resolve(
            errorPayload("internal", err instanceof Error ? err.message : "Signing failed"),
          );
        }
        return true;
      }

      if (entry.request.method === "sign_auth_entry") {
        try {
          const store = getDeviceKeyStore();
          const pair = await store.get();
          if (isAborted()) return false;
          if (!pair) {
            entry.resolve(errorPayload("disconnected", "No device signer — re-pair the extension"));
            return true;
          }
          const rawPublicKey = Uint8Array.from(
            (await devicePublicKeyHexImpl(pair)).match(/../g)!.map((b) => parseInt(b, 16)),
          );
          if (isAborted()) return false;
          const signedAuthEntry = await signAuthEntryXdrImpl({
            authEntry: entry.request.params.authEntry,
            wallet,
            deviceKeyPair: pair,
            deviceRawPublicKey: rawPublicKey,
          });
          if (isAborted()) return false;
          entry.resolve({ method: "sign_auth_entry", result: { signedAuthEntry } });
        } catch (err) {
          if (isAborted()) return false;
          void reporter.reportError(err, {
            method: "sign_auth_entry",
            origin: entry.origin,
          });
          entry.resolve(
            errorPayload("internal", err instanceof Error ? err.message : "Signing failed"),
          );
        }
        return true;
      }

      if (entry.request.method === "sign_message") {
        try {
          const store = getDeviceKeyStore();
          const pair = await store.get();
          if (isAborted()) return false;
          if (!pair) {
            entry.resolve(errorPayload("disconnected", "No device signer — re-pair the extension"));
            return true;
          }
          const signedMessage = await signMessageBytesImpl({
            message: entry.request.params.message,
            deviceKeyPair: pair,
          });
          if (isAborted()) return false;
          entry.resolve({ method: "sign_message", result: { signedMessage } });
        } catch (err) {
          if (isAborted()) return false;
          void reporter.reportError(err, {
            method: "sign_message",
            origin: entry.origin,
          });
          entry.resolve(
            errorPayload("internal", err instanceof Error ? err.message : "Signing failed"),
          );
        }
        return true;
      }

      // Connect, sign, and pair approvals are the full set today.
      entry.resolve(errorPayload("internal", `Unexpected approval for ${entry.request.method}`));
      return true;
    } finally {
      resolving.delete(id);
      abortedRequests.delete(id);
    }
  }

  async function handlePairApproval(
    entry: PendingApproval,
    isAborted: () => boolean,
  ): Promise<void> {
    if (entry.request.method !== "pair") {
      entry.resolve(errorPayload("internal", "Not a pair request"));
      return;
    }
    const { address, network, rpcUrl, keyId, walletWasmHash } = entry.request.params;
    const pair = await ensureDeviceKeyImpl(getDeviceKeyStore());
    if (isAborted()) return;
    const pubKeyHex = await devicePublicKeyHexImpl(pair);
    if (isAborted()) return;

    // Store the paired identity only if the requesting tab is still open, then
    // hand the device signer's public key to the web app — the on-chain
    // addEd25519 still requires the user's passkey.
    // entry.origin is the TRUSTED sender origin — it becomes the deep-link target.
    await setPairedWallet(kv, {
      address,
      network,
      rpcUrl,
      keyId,
      walletWasmHash,
      webAppOrigin: entry.origin,
    });
    if (isAborted()) return;
    entry.resolve({
      method: "pair",
      result: { devicePublicKeyHex: pubKeyHex },
    });
  }

  function listPending(): PendingApprovalSummary[] {
    return [...pending.values()].map(({ id, origin, request }) => ({ id, origin, request }));
  }

  runtimeApi?.onMessage?.addListener((raw: unknown, sender) => {
    const message = raw as ExtensionMessage;
    switch (message?.type) {
      case "provider-request":
        return handleProviderRequest(message, sender);
      case "list-pending":
        return Promise.resolve(listPending());
      case "resolve-pending":
        return handleResolvePending(message.id, message.approved);
      default:
        return undefined;
    }
  });

  return {
    handleProviderRequest,
    handleResolvePending,
    handleTabRemoved,
    listPending,
    getApprovalWindowId: () => approvalWindowId,
  };
}

export default defineBackground(() => {
  // Global unhandled error handlers for background worker (#302)
  if (typeof self !== "undefined") {
    self.addEventListener("error", (event) => {
      void backgroundErrorReporter.reportError(event.error ?? event.message, {
        source: "background_unhandled_error",
      });
    });
    self.addEventListener("unhandledrejection", (event) => {
      void backgroundErrorReporter.reportError(event.reason, {
        source: "background_unhandled_rejection",
      });
    });
  }

  createBackgroundController();
});
