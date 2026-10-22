import "../../lib/buffer-polyfill";
import "./popup.css";
import "./screens.css";
import { useCallback, useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { PermissionGrant } from "@vellar/provider-sdk";
import { browserKv } from "../../lib/browser-kv";
import {
  checkDeviceKeyStatus,
  createIdbDeviceKeyStore,
  type DeviceKeyStatus,
} from "../../lib/device-key";
import type { PendingApprovalSummary } from "../../lib/messages";
import { loadState, revokeGrant, STATE_KEY, type ExtensionState } from "../../lib/state";
import { ApprovalScreen } from "./ApprovalScreen";
import { DeviceKeyRecovery } from "./DeviceKeyRecovery";
import { HomeScreen } from "./HomeScreen";

// Popup (technical-doc.md §4.2, §7.3; design.md §8): a pending approval takes
// over the whole frame, one at a time, with the requesting origin ALWAYS shown
// (§8.2). With nothing pending, the popup home renders.

export function App() {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [approvals, setApprovals] = useState<PendingApprovalSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [deviceKeyStatus, setDeviceKeyStatus] = useState<DeviceKeyStatus | null>(null);

  const refresh = useCallback(async () => {
    setState(await loadState(browserKv));
    const pending = ((await browser.runtime.sendMessage({
      type: "list-pending",
    })) ?? []) as PendingApprovalSummary[];
    setApprovals(pending);
    // Queue size only grows while requests arrive; resets once drained.
    setTotal((t) => (pending.length === 0 ? 0 : Math.max(t, pending.length)));
    return pending;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A pairing/approval can land while this popup instance is already open —
  // e.g. the user approves a connection in a separate approval window, or
  // the web app pairs a new grant directly. browser.storage.onChanged fires
  // in every open extension context, so an already-open popup's "Connected
  // dApps" list updates immediately instead of requiring it to be closed
  // and reopened (#588).
  useEffect(() => {
    const onChanged = (changes: Record<string, unknown>, areaName: string) => {
      if (areaName === "local" && STATE_KEY in changes) void refresh();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [refresh]);
  // #581: check the device key on every popup open, read-only. A wallet is
  // paired but the local signing key can't be loaded/verified — distinct from
  // the normal pre-pairing "missing" state, which the Unpaired screen already
  // covers and needs no banner.
  useEffect(() => {
    void checkDeviceKeyStatus(createIdbDeviceKeyStore()).then((check) =>
      setDeviceKeyStatus(check.status),
    );
  }, []);

  const isApprovalWindow = new URLSearchParams(window.location.search).has("approval");

  async function onResolved() {
    const remaining = await refresh();
    if (isApprovalWindow && remaining.length === 0) window.close();
  }

  async function revoke(grant: PermissionGrant) {
    await revokeGrant(browserKv, grant.origin, grant.network);
    await refresh();
  }

  const current = approvals[0];
  if (current) {
    return (
      <ApprovalScreen
        key={current.id}
        approval={current}
        position={total - approvals.length + 1}
        total={total}
        wallet={state?.pairedWallet}
        onResolved={() => void onResolved()}
      />
    );
  }

  // Only a paired wallet with a broken/invalid key needs the recovery path —
  // pre-pairing "missing" is the ordinary first-run state (Unpaired screen).
  const needsKeyRecovery =
    !!state?.pairedWallet && (deviceKeyStatus === "load_failed" || deviceKeyStatus === "invalid");

  if (needsKeyRecovery && deviceKeyStatus) {
    return <DeviceKeyRecovery status={deviceKeyStatus} wallet={state!.pairedWallet} />;
  }

  return <HomeScreen state={state} onRevoke={(grant) => void revoke(grant)} />;
}
