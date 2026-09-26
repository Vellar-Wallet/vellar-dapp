import "../../lib/buffer-polyfill";
import "./popup.css";
import "./screens.css";
import { useCallback, useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { PermissionGrant } from "@vellar/provider-sdk";
import { browserKv } from "../../lib/browser-kv";
import type { PendingApprovalSummary } from "../../lib/messages";
import { loadState, revokeGrant, type ExtensionState } from "../../lib/state";
import { ApprovalScreen } from "./ApprovalScreen";
import { HomeScreen } from "./HomeScreen";

// Popup (technical-doc.md §4.2, §7.3; design.md §8): a pending approval takes
// over the whole frame, one at a time, with the requesting origin ALWAYS shown
// (§8.2). With nothing pending, the popup home renders.

export function App() {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [approvals, setApprovals] = useState<PendingApprovalSummary[]>([]);
  const [total, setTotal] = useState(0);

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

  return <HomeScreen state={state} onRevoke={(grant) => void revoke(grant)} />;
}
