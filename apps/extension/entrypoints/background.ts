import { defineBackground } from "#imports";
import "../lib/buffer-polyfill";
import { browser as realBrowser } from "wxt/browser";
import {
  CONNECT_GRANT_CAPABILITIES,
  errorPayload,
  type ResponsePayload,
} from "@vellar/provider-sdk";
import { browserKv as realBrowserKv } from "../lib/browser-kv";
import { createIdbDeviceKeyStore, devicePublicKeyHex, ensureDeviceKey } from "../lib/device-key";
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
  PairedOriginLimitError,
  revokeGrant,
  setPairedWallet,
  type KeyValueStore,
} from "../lib/state";
import { backgroundErrorReporter } from "../lib/error-reporter";

import { PairedTabManager, type PendingApprovalEntry } from "../lib/paired-tab-manager";

// Background service worker (technical-doc.md §6.2B, §7.3): routes validated
// dApp requests, holds the pending-approval queue, and opens the approval
// popup. The trusted origin comes exclusively from the message sender.
//
// SUSPENSION / RESTART ASSUMPTIONS (issues #775, #776)
// ----------------------------------------------------
// Manifest V3 may suspend this worker between events, and an extension update
// may replace it entirely. The pending-approval queue lives in `PairedTabManager`,
// which is IN-MEMORY ONLY: nothing about a pending request is written to
// `browserKv` or any other persistent store. Consequences, made explicit here
// so callers do not mistake an implementation detail for a guarantee:
//
//   * After a suspension/restart a fresh worker has an EMPTY pending queue.
//     `list-pending` returns [] and `resolve-pending` for an old id returns
//     false promptly rather than resolving a stale promise.
//   * The dApp's original `browser.runtime.sendMessage` promise dies with the
//     old worker; the content script's own timeout is what releases the page.
//     We deliberately do NOT claim to "fail clearly" from the worker after it
//     has been replaced, because there is no surviving channel to the page.
//   * Paired wallet identity and permission grants ARE persisted (in
//     `browserKv`). Requests routed after a restart are decided from that
//     freshly loaded state; the router itself holds no state at all.
//
// `createBackgroundRuntime` is the injectable core: the default export below
// is a thin production wrapper that binds the real WXT browser and storage.

export interface BackgroundBrowser {
  tabs: {
    onRemoved: { addListener(callback: (tabId: number) => void): void };
  };
  windows: {
    onRemoved: { addListener(callback: (windowId: number) => void): void };
    remove(windowId: number): Promise<void>;
    update(windowId: number, info: { focused: boolean }): Promise<unknown>;
    create(info: {
      url: string;
      type: "popup";
      width: number;
      height: number;
    }): Promise<{ id?: number } | undefined>;
  };
  runtime: {
    getURL(path: string): string;
  };
}

export interface BackgroundSender {
  origin?: string;
  url?: string;
  tab?: { id?: number };
}

export interface BackgroundRuntimeOptions {
  /** Browser API surface actually used by the worker (injected in tests). */
  browser: BackgroundBrowser;
  /** Persistent KV backing paired-wallet/grant state. */
  kv: KeyValueStore;
  /** Resolved pair-origin allowlist (fail-closed in the production wrapper). */
  pairOrigins: PairOriginPolicy;
  /** Fire-and-forget error reporter hook. */
  reportError(error: unknown, context?: Record<string, unknown>): void;
  /** Clock used for grant timestamps; injectable for deterministic tests. */
  now(): string;
}

export interface BackgroundRuntime {
  /** Exposed so tests can simulate a fresh worker with a new in-memory queue. */
  requestManager: PairedTabManager;
  handleProviderRequest(
    message: ProviderRequestMessage,
    sender: BackgroundSender,
  ): Promise<ResponsePayload>;
  handleResolvePending(id: string, approved: boolean): Promise<boolean>;
  listPending(): PendingApprovalSummary[];
  handleMessage(
    raw: unknown,
    sender: BackgroundSender,
  ): Promise<ResponsePayload | boolean | PendingApprovalSummary[]> | undefined;
}

export function createBackgroundRuntime(options: BackgroundRuntimeOptions): BackgroundRuntime {
  const { browser, kv, pairOrigins, reportError, now } = options;

  const requestManager = new PairedTabManager({
    closeWindow: async (winId) => {
      try {
        await browser.windows.remove(winId);
      } catch {
        // window was already closed
      }
    },
  });

  browser.tabs.onRemoved.addListener((closedTabId) => {
    void requestManager.handleTabRemoved(closedTabId);
  });

  browser.windows.onRemoved.addListener((closedId) => {
    requestManager.handleWindowRemoved(closedId);
  });

  async function handleProviderRequest(
    message: ProviderRequestMessage,
    sender: BackgroundSender,
  ): Promise<ResponsePayload> {
    const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
    if (!origin || !sender.tab) {
      return errorPayload("invalid_request", "Request did not come from a page context");
    }

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
    // never stack duplicate cards. A request from a DIFFERENT origin (e.g. a
    // second tab paired to the same wallet) is always independent (#582): it
    // never supersedes, and gets its own approval card.
    requestManager.supersedePending(decision.origin, message.envelope.request.method);

    return new Promise<ResponsePayload>((resolve) => {
      const id = message.envelope.id;
      requestManager.addPending({
        id,
        origin: decision.origin,
        request: message.envelope.request,
        tabId: sender.tab?.id,
        resolve,
      });
      void openApprovalWindow();
    });
  }

  async function openApprovalWindow(): Promise<void> {
    // Reuse an already-open approval window; only create one if none exists.
    if (requestManager.approvalWindowId !== undefined) {
      try {
        await browser.windows.update(requestManager.approvalWindowId, { focused: true });
        return;
      } catch {
        requestManager.approvalWindowId = undefined; // window was gone; fall through to create
      }
    }
    const win = await browser.windows.create({
      url: browser.runtime.getURL("/popup.html?approval=1"),
      type: "popup",
      width: 380,
      height: 600,
    });
    requestManager.approvalWindowId = win?.id;
  }

  async function handleResolvePending(id: string, approved: boolean): Promise<boolean> {
    const entry = requestManager.startResolving(id);
    if (!entry) return false;

    if (!approved) {
      requestManager.finishResolving(id, errorPayload("rejected", "The user declined the request"));
      return true;
    }

    if (entry.request.method === "pair") {
      try {
        await handlePairApproval(entry);
        requestManager.finishResolving(id);
      } catch (err) {
        requestManager.finishResolving(
          id,
          errorPayload("internal", err instanceof Error ? err.message : "Pairing failed"),
        );
      }
      return true;
    }

    const state = await loadState(kv);
    const wallet = state.pairedWallet;
    if (!wallet) {
      requestManager.finishResolving(id, errorPayload("disconnected", "No wallet is paired"));
      return true;
    }

    if (entry.request.method === "connect") {
      try {
        await addGrant(kv, {
          origin: entry.origin,
          accountId: wallet.address,
          network: wallet.network,
          capabilities: [...CONNECT_GRANT_CAPABILITIES],
          grantedAt: now(),
        });
      } catch (err) {
        // #579: the paired-origin limit was hit — surface it as a clear error
        // rather than letting the popup crash on an unhandled rejection.
        if (err instanceof PairedOriginLimitError) {
          entry.resolve(errorPayload("paired_origin_limit_reached", err.message));
          return true;
        }
        throw err;
      }
      entry.resolve({
        method: "connect",
        result: { address: wallet.address, network: wallet.network },
      });
      return true;
    }

    if (entry.request.method === "sign_transaction") {
      try {
        const store = createIdbDeviceKeyStore();
        const stored = await store.get();
        if (!stored?.pair || stored.walletAddress !== wallet.address) {
          requestManager.finishResolving(
            id,
            errorPayload("disconnected", "No device signer for this wallet, re-pair the extension"),
          );
          return true;
        }
        const pair = stored.pair;
        const rawPublicKey = Uint8Array.from(
          (await devicePublicKeyHex(pair)).match(/../g)!.map((b) => parseInt(b, 16)),
        );
        const signedXdr = await signTransactionXdr({
          xdr: entry.request.params.xdr,
          wallet,
          deviceKeyPair: pair,
          deviceRawPublicKey: rawPublicKey,
        });
        requestManager.finishResolving(id, { method: "sign_transaction", result: { signedXdr } });
      } catch (err) {
        reportError(err, { method: "sign_transaction", origin: entry.origin });
        requestManager.finishResolving(
          id,
          errorPayload("internal", err instanceof Error ? err.message : "Signing failed"),
        );
      }
      return true;
    }

    if (entry.request.method === "sign_auth_entry") {
      try {
        const store = createIdbDeviceKeyStore();
        const stored = await store.get();
        if (!stored?.pair || stored.walletAddress !== wallet.address) {
          requestManager.finishResolving(
            id,
            errorPayload("disconnected", "No device signer for this wallet, re-pair the extension"),
          );
          return true;
        }
        const pair = stored.pair;
        const rawPublicKey = Uint8Array.from(
          (await devicePublicKeyHex(pair)).match(/../g)!.map((b) => parseInt(b, 16)),
        );
        const signedAuthEntry = await signAuthEntryXdr({
          authEntry: entry.request.params.authEntry,
          wallet,
          deviceKeyPair: pair,
          deviceRawPublicKey: rawPublicKey,
        });
        requestManager.finishResolving(id, {
          method: "sign_auth_entry",
          result: { signedAuthEntry },
        });
      } catch (err) {
        reportError(err, { method: "sign_auth_entry", origin: entry.origin });
        requestManager.finishResolving(
          id,
          errorPayload("internal", err instanceof Error ? err.message : "Signing failed"),
        );
      }
      return true;
    }

    if (entry.request.method === "sign_message") {
      try {
        const store = createIdbDeviceKeyStore();
        const stored = await store.get();
        if (!stored?.pair || stored.walletAddress !== wallet.address) {
          requestManager.finishResolving(
            id,
            errorPayload("disconnected", "No device signer for this wallet, re-pair the extension"),
          );
          return true;
        }
        const pair = stored.pair;
        const signedMessage = await signMessageBytes({
          message: entry.request.params.message,
          deviceKeyPair: pair,
        });
        requestManager.finishResolving(id, { method: "sign_message", result: { signedMessage } });
      } catch (err) {
        reportError(err, { method: "sign_message", origin: entry.origin });
        requestManager.finishResolving(
          id,
          errorPayload("internal", err instanceof Error ? err.message : "Signing failed"),
        );
      }
      return true;
    }

    // Connect, sign, and pair approvals are the full set today.
    requestManager.finishResolving(
      id,
      errorPayload("internal", `Unexpected approval for ${entry.request.method}`),
    );
    return true;
  }

  async function handlePairApproval(entry: PendingApprovalEntry): Promise<void> {
    if (entry.request.method !== "pair") {
      entry.resolve(errorPayload("internal", "Not a pair request"));
      return;
    }
    const { address, network, rpcUrl, keyId, walletWasmHash } = entry.request.params;
    // Store the paired identity, then hand the device signer's public key to
    // the web app — the on-chain addEd25519 still requires the user's passkey.
    // entry.origin is the TRUSTED sender origin — it becomes the deep-link target.
    await setPairedWallet(kv, {
      address,
      network,
      rpcUrl,
      keyId,
      walletWasmHash,
      webAppOrigin: entry.origin,
    });
    const pair = await ensureDeviceKey(createIdbDeviceKeyStore(), address);
    entry.resolve({
      method: "pair",
      result: { devicePublicKeyHex: await devicePublicKeyHex(pair) },
    });
  }

  function handleMessage(
    raw: unknown,
    sender: BackgroundSender,
  ): Promise<ResponsePayload | boolean | PendingApprovalSummary[]> | undefined {
    const message = raw as ExtensionMessage;
    switch (message?.type) {
      case "provider-request":
        return handleProviderRequest(message, sender);
      case "list-pending":
        return Promise.resolve(requestManager.listPending());
      case "resolve-pending":
        return handleResolvePending(message.id, message.approved);
      default:
        return undefined;
    }
  }

  return {
    requestManager,
    handleProviderRequest,
    handleResolvePending,
    listPending: () => requestManager.listPending(),
    handleMessage,
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

  // L3: resolve the pair-origin allowlist once at startup. A misconfigured
  // production build (no origins, no escape hatch) throws — we DISABLE pairing
  // rather than fall back, so an unconfigured prod artifact can never pair with
  // an arbitrary origin. An empty allowlist (`[]`) refuses every `pair`.
  let pairOrigins: PairOriginPolicy;
  try {
    pairOrigins = pairOriginPolicy();
    if (pairOrigins === "any") {
      console.warn(
        "[vellar] WXT_PUBLIC_ALLOW_ANY_PAIR_ORIGIN is set — ANY origin may pair the extension. " +
          "Do not ship this in a production build.",
      );
    }
  } catch (err) {
    if (err instanceof PairOriginsMisconfiguredError) {
      console.error(`[vellar] pairing disabled: ${err.message}`);
      void backgroundErrorReporter.reportError(err, { source: "pair_origins_misconfigured" });
      pairOrigins = []; // fail closed: no origin may pair
    } else {
      void backgroundErrorReporter.reportError(err, { source: "pair_origins_init" });
      throw err;
    }
  }

  const runtime = createBackgroundRuntime({
    browser: realBrowser,
    kv: realBrowserKv,
    pairOrigins,
    reportError: (error, context) => {
      void backgroundErrorReporter.reportError(error, context);
    },
    now: () => new Date().toISOString(),
  });

  realBrowser.runtime.onMessage.addListener((raw: unknown, sender) =>
    runtime.handleMessage(raw, sender),
  );
});
