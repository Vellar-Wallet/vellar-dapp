import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { xdr } from "@stellar/stellar-sdk";
import fixture from "./fixtures/reconnect.json";

// e2e: "reconnect" (idea.md §15), CI-safe half — an existing user signing back
// in with the passkey they already have. The live-testnet half (create → fund →
// pay → disconnect → sign in) is in wallet.spec.ts (see e2e/README.md).
//
// Nothing above the network is stubbed: the real /app page, the real
// passkey-kit connectWallet, and a real WebAuthn ceremony — a CDP virtual
// authenticator holding an actual P-256 passkey signs the assertion. What is
// replayed:
//   - Soroban RPC getLedgerEntries: the wallet instance + the passkey's
//     SignerVal, encoded with passkey-kit's own contract Spec;
//   - the wallet API: /wallet/connect and /wallet/sessions responses captured
//     from the real wallet-service.
// Both come from fixtures/reconnect.json, generated and drift-checked by
// services/wallet-service/src/e2e-fixtures.test.ts (security-audit.md RA-9).

const API = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const RPC = (process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org").replace(
  /\/+$/,
  "",
);

type Reply = { status: number; body: unknown };
type LedgerName = keyof typeof fixture.ledger;

async function addPasskeyAuthenticator(
  context: BrowserContext,
  page: Page,
  { withCredential }: { withCredential: boolean },
) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  if (withCredential) {
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: fixture.credential });
  }
  return { cdp, authenticatorId };
}

/**
 * Replay the chain: getLedgerEntries answers only for the entries named in
 * `onChain` (a missing entry is a genuine not-found, exactly as RPC reports
 * it). Returns the ledger keys the kit asked for.
 */
async function mockSorobanRpc(page: Page, onChain: LedgerName[]) {
  const entries = new Map(onChain.map((name) => [fixture.ledger[name].key, fixture.ledger[name]]));
  const requested: LedgerName[] = [];
  const nameOf = new Map(
    (Object.keys(fixture.ledger) as LedgerName[]).map((n) => [fixture.ledger[n].key, n]),
  );
  await page.route(
    (url) => url.href.startsWith(RPC),
    async (route) => {
      const req = route.request().postDataJSON() as {
        id: number | string;
        method: string;
        params?: { keys?: string[] } | string[][];
      };
      const json = (body: object) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }),
        });
      if (req.method !== "getLedgerEntries") {
        // Balances etc. are out of scope for reconnect; fail them like an RPC would.
        return json({ error: { code: -32601, message: `${req.method} not replayed in this e2e` } });
      }
      const keys = Array.isArray(req.params) ? req.params[0]! : (req.params?.keys ?? []);
      for (const k of keys) {
        // Normalize (decode/re-encode) so a formatting difference can't hide a match.
        const key = xdr.LedgerKey.fromXDR(k, "base64").toXDR("base64");
        const name = nameOf.get(key);
        if (name) requested.push(name);
      }
      const found = keys
        .map((k) => entries.get(xdr.LedgerKey.fromXDR(k, "base64").toXDR("base64")))
        .filter((e) => e !== undefined)
        .map((e) => ({ key: e.key, xdr: e.xdr, lastModifiedLedgerSeq: 1000, liveUntilLedgerSeq: 9_000_000 }));
      return json({ result: { entries: found, latestLedger: 2000 } });
    },
  );
  return requested;
}

/** Replay the wallet API. Returns what the page sent (body + bearer). */
async function mockWalletApi(page: Page, connect: Reply) {
  const calls: { path: string; body: unknown; authorization: string | undefined }[] = [];
  await page.route(
    (url) => url.href.startsWith(`${API}/wallet/`),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      calls.push({
        path,
        body: req.method() === "POST" ? req.postDataJSON() : undefined,
        authorization: await req.headerValue("authorization").then((v) => v ?? undefined),
      });
      const reply: Reply =
        path === "/wallet/connect"
          ? connect
          : path === "/wallet/sessions"
            ? fixture.sessions
            : { status: 599, body: { error: `unexpected ${path} in reconnect e2e` } };
      await route.fulfill({
        status: reply.status,
        contentType: "application/json",
        body: JSON.stringify(reply.body),
      });
    },
  );
  return calls;
}

async function storedSession(page: Page) {
  const raw = await page.evaluate(() => window.localStorage.getItem("vellar.session"));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

const pageAlert = (page: Page) => page.locator('p[role="alert"]');

async function signIn(page: Page) {
  await page.goto("/app");
  await page.getByRole("button", { name: "Sign in" }).click();
}

// @ci — fully mocked (no backend/secrets/testnet), safe to run in CI.
test.describe("reconnect with an existing passkey (kit-encoded chain + captured wallet API) @ci", () => {
  test("signs back in to the SAME wallet, verified on-chain, with a new server session", async ({
    page,
    context,
  }) => {
    await addPasskeyAuthenticator(context, page, { withCredential: true });
    const rpcKeys = await mockSorobanRpc(page, ["walletInstance", "passkeySigner"]);
    const api = await mockWalletApi(page, fixture.connectOk);

    await signIn(page);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });

    // The kit resolved the wallet from the passkey and checked, on-chain, that
    // this passkey is a live signer on it — not merely that some server said so.
    expect(rpcKeys).toContain("walletInstance");
    expect(rpcKeys).toContain("passkeySigner");

    // A server session was opened for this passkey (the kit's derivation path
    // skips /wallet/connect; ensureServerSession must still call it — once).
    const connects = api.filter((c) => c.path === "/wallet/connect");
    expect(connects).toEqual([
      { path: "/wallet/connect", body: { keyId: fixture.keyId, network: "testnet" }, authorization: undefined },
    ]);

    // The persisted session is the reconnected wallet, the passkey, and the
    // server's bearer — everything later signing and Settings depend on.
    expect(await storedSession(page)).toMatchObject({
      accountId: fixture.wallet,
      network: "testnet",
      connected: true,
      authMethod: "passkey",
      keyId: fixture.keyId,
      serverSessionId: fixture.connectOk.body.sessionId,
    });

    // The UI shows the same account.
    await page.getByRole("button", { name: "Receive" }).click();
    await expect(page.getByTestId("receive-address")).toHaveText(fixture.wallet);

    // Settings lists the session as this device, fetched WITH the new bearer.
    await page.goto("/settings");
    await expect(page.getByText("This device", { exact: true })).toBeVisible({ timeout: 30_000 });
    const list = api.find((c) => c.path === "/wallet/sessions");
    expect(list?.authorization).toBe(`Bearer ${fixture.connectOk.body.sessionId}`);

    // And the session survives a reload without another passkey prompt.
    await page.reload();
    await expect(page.getByText("This device", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(api.filter((c) => c.path === "/wallet/connect")).toHaveLength(1);
  });

  test("a passkey that is NOT a signer on the derived wallet is refused (ownership check)", async ({
    page,
    context,
  }) => {
    await addPasskeyAuthenticator(context, page, { withCredential: true });
    // The wallet exists on-chain, but this passkey's signer entry does not.
    const rpcKeys = await mockSorobanRpc(page, ["walletInstance"]);
    const api = await mockWalletApi(page, fixture.connectOk);

    await signIn(page);
    await expect(pageAlert(page)).toHaveText(/isn't a signer/i, { timeout: 60_000 });
    await expect(page).toHaveURL(/\/app$/);
    expect(rpcKeys).toContain("passkeySigner");
    expect(await storedSession(page)).toBeNull();
    // No server session is opened for a refused sign-in.
    expect(api.filter((c) => c.path === "/wallet/connect")).toHaveLength(0);
  });

  test("a passkey with no Vellar wallet (not on-chain, server 404) is refused", async ({
    page,
    context,
  }) => {
    await addPasskeyAuthenticator(context, page, { withCredential: true });
    await mockSorobanRpc(page, []);
    const api = await mockWalletApi(page, fixture.connectNotFound);

    await signIn(page);
    await expect(pageAlert(page)).toHaveText(/no vellar wallet was found/i, { timeout: 60_000 });
    await expect(page).toHaveURL(/\/app$/);
    expect(await storedSession(page)).toBeNull();
    // The kit fell back to the server lookup before giving up.
    expect(api.filter((c) => c.path === "/wallet/connect")).toHaveLength(1);
  });

  test("the server rate-limits sign-in attempts (429) → its message, not signed in", async ({
    page,
    context,
  }) => {
    await addPasskeyAuthenticator(context, page, { withCredential: true });
    await mockSorobanRpc(page, []);
    await mockWalletApi(page, fixture.connectRateLimited);

    await signIn(page);
    await expect(pageAlert(page)).toHaveText(fixture.connectRateLimited.body.message, {
      timeout: 60_000,
    });
    await expect(page).toHaveURL(/\/app$/);
    expect(await storedSession(page)).toBeNull();
  });

  test("no passkey on this device → treated as a cancel: no error, not signed in, can retry", async ({
    page,
    context,
  }) => {
    await addPasskeyAuthenticator(context, page, { withCredential: false });
    await mockSorobanRpc(page, ["walletInstance", "passkeySigner"]);
    const api = await mockWalletApi(page, fixture.connectOk);

    await signIn(page);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled({ timeout: 60_000 });
    await expect(pageAlert(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/app$/);
    expect(await storedSession(page)).toBeNull();
    expect(api).toHaveLength(0);
  });
});
