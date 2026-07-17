import { defineBackground } from "#imports";
import "../lib/buffer-polyfill";
import { browser } from "wxt/browser";
import { CONNECT_GRANT_CAPABILITIES, errorPayload, type ResponsePayload } from "@vela/provider-sdk";
import { browserKv } from "../lib/browser-kv";
import { createIdbDeviceKeyStore, devicePublicKeyHex, ensureDeviceKey } from "../lib/device-key";
import { signTransactionXdr } from "../lib/tx-signer";
import type {
  ExtensionMessage,
  PendingApprovalSummary,
  ProviderRequestMessage,
} from "../lib/messages";
import { routeProviderRequest } from "../lib/router";
import { addGrant, loadState, revokeGrant, setPairedWallet } from "../lib/state";

// Background service worker (technical-doc.md §6.2B, §7.3): routes validated
// dApp requests, holds the pending-approval queue, and opens the approval
// popup. The trusted origin comes exclusively from the message sender.

interface PendingApproval extends PendingApprovalSummary {
  resolve(payload: ResponsePayload): void;
}

export default defineBackground(() => {
  const pending = new Map<string, PendingApproval>();
  // Track the open approval window so we don't spawn a new one per request.
  let approvalWindowId: number | undefined;

  browser.windows.onRemoved.addListener((closedId) => {
    if (closedId === approvalWindowId) approvalWindowId = undefined;
  });

  async function handleProviderRequest(
    message: ProviderRequestMessage,
    sender: { origin?: string; url?: string; tab?: unknown },
  ): Promise<ResponsePayload> {
    const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
    if (!origin || !sender.tab) {
      return errorPayload("invalid_request", "Request did not come from a page context");
    }

    const state = await loadState(browserKv);
    const decision = routeProviderRequest(message.envelope.request, origin, state);

    if (decision.kind === "respond") {
      if (decision.revokeGrant && state.pairedWallet) {
        await revokeGrant(browserKv, origin, state.pairedWallet.network);
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
      pending.set(id, { id, origin: decision.origin, request: message.envelope.request, resolve });
      void openApprovalWindow();
    });
  }

  async function openApprovalWindow(): Promise<void> {
    // Reuse an already-open approval window; only create one if none exists.
    if (approvalWindowId !== undefined) {
      try {
        await browser.windows.update(approvalWindowId, { focused: true });
        return;
      } catch {
        approvalWindowId = undefined; // window was gone; fall through to create
      }
    }
    const win = await browser.windows.create({
      url: browser.runtime.getURL("/popup.html?approval=1"),
      type: "popup",
      width: 380,
      height: 600,
    });
    approvalWindowId = win?.id;
  }

  async function handleResolvePending(id: string, approved: boolean): Promise<boolean> {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);

    if (!approved) {
      entry.resolve(errorPayload("rejected", "The user declined the request"));
      return true;
    }

    if (entry.request.method === "pair") {
      await handlePairApproval(entry);
      return true;
    }

    const state = await loadState(browserKv);
    const wallet = state.pairedWallet;
    if (!wallet) {
      entry.resolve(errorPayload("disconnected", "No wallet is paired"));
      return true;
    }

    if (entry.request.method === "connect") {
      await addGrant(browserKv, {
        origin: entry.origin,
        accountId: wallet.address,
        network: wallet.network,
        capabilities: [...CONNECT_GRANT_CAPABILITIES],
        grantedAt: new Date().toISOString(),
      });
      entry.resolve({
        method: "connect",
        result: { address: wallet.address, network: wallet.network },
      });
      return true;
    }

    if (entry.request.method === "sign_transaction") {
      try {
        const store = createIdbDeviceKeyStore();
        const pair = await store.get();
        if (!pair) {
          entry.resolve(errorPayload("disconnected", "No device signer — re-pair the extension"));
          return true;
        }
        const rawPublicKey = Uint8Array.from(
          (await devicePublicKeyHex(pair)).match(/../g)!.map((b) => parseInt(b, 16)),
        );
        const signedXdr = await signTransactionXdr({
          xdr: entry.request.params.xdr,
          wallet,
          deviceKeyPair: pair,
          deviceRawPublicKey: rawPublicKey,
        });
        entry.resolve({ method: "sign_transaction", result: { signedXdr } });
      } catch (err) {
        entry.resolve(
          errorPayload("internal", err instanceof Error ? err.message : "Signing failed"),
        );
      }
      return true;
    }

    // Connect, sign, and pair approvals are the full set today.
    entry.resolve(errorPayload("internal", `Unexpected approval for ${entry.request.method}`));
    return true;
  }

  async function handlePairApproval(entry: PendingApproval): Promise<void> {
    if (entry.request.method !== "pair") {
      entry.resolve(errorPayload("internal", "Not a pair request"));
      return;
    }
    const { address, network, rpcUrl, keyId, walletWasmHash } = entry.request.params;
    // Store the paired identity, then hand the device signer's public key to
    // the web app — the on-chain addEd25519 still requires the user's passkey.
    // entry.origin is the TRUSTED sender origin — it becomes the deep-link target.
    await setPairedWallet(browserKv, {
      address,
      network,
      rpcUrl,
      keyId,
      walletWasmHash,
      webAppOrigin: entry.origin,
    });
    const pair = await ensureDeviceKey(createIdbDeviceKeyStore());
    entry.resolve({
      method: "pair",
      result: { devicePublicKeyHex: await devicePublicKeyHex(pair) },
    });
  }

  browser.runtime.onMessage.addListener((raw: unknown, sender) => {
    const message = raw as ExtensionMessage;
    switch (message?.type) {
      case "provider-request":
        return handleProviderRequest(message, sender);
      case "list-pending":
        return Promise.resolve(
          [...pending.values()].map(({ id, origin, request }) => ({ id, origin, request })),
        );
      case "resolve-pending":
        return handleResolvePending(message.id, message.approved);
      default:
        return undefined;
    }
  });
});
