import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fundSmartWallet } from "./fund";

// LIVE extension e2e (technical-doc.md §7.2–7.4, §14 MVP extension scenarios):
// loads the built MV3 extension, creates a passkey wallet, pairs the extension
// as an on-chain device signer, then acts as a third-party dApp: connection
// approval + one-click device-signer transaction signing, submitted to
// testnet. Requires gateway/wallet-service running with .env (relayer +
// sponsor) — same as wallet.spec.ts.

const EXTENSION_PATH = path.resolve(__dirname, "../../extension/.output/chrome-mv3");
const DAPP_ORIGIN = "https://dapp-e2e.example";

test.skip(!existsSync(EXTENSION_PATH), "extension not built (pnpm --filter @vela/extension build)");

async function enableVirtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** Waits for the extension approval popup window and clicks a button in it. */
async function approveInPopup(context: BrowserContext, buttonName: RegExp) {
  const popup = await context.waitForEvent("page", {
    predicate: (p) => p.url().includes("popup.html"),
    timeout: 30_000,
  });
  await popup.getByRole("button", { name: buttonName }).click();
}

test("extension: pair, dApp connect, one-click device-signer payment (live testnet)", async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  try {
    // --- Create a passkey wallet in the web app ---
    const web = await context.newPage();
    web.on("console", (msg) => {
      if (msg.type() === "error") console.log("[web]", msg.text());
    });
    await enableVirtualAuthenticator(context, web);
    await web.goto("http://localhost:3000/app");
    await web.getByLabel(/wallet name/i).fill("ext e2e");
    await web.getByRole("button", { name: "Create wallet" }).click();
    await expect(web).toHaveURL(/\/dashboard/, { timeout: 120_000 });

    await web.getByRole("button", { name: "Receive" }).click();
    const addressLocator = web.locator("p.mono", { hasText: /^C[A-Z2-7]{55}$/ }).first();
    await expect(addressLocator).toBeVisible({ timeout: 30_000 });
    const contractId = (await addressLocator.textContent())!.trim();
    await web.getByRole("button", { name: "Close" }).click();

    // --- Pair the extension (popup approval + passkey addEd25519 on-chain) ---
    await web.goto("http://localhost:3000/settings");
    const pairClick = web.getByRole("button", { name: "Pair extension" }).click();
    await approveInPopup(context, /approve/i);
    await pairClick;
    await expect(web.getByText(/extension paired/i)).toBeVisible({ timeout: 120_000 });

    // --- Fund the wallet so it can pay ---
    const funder = await fundSmartWallet(contractId, 25n);

    // --- Act as a third-party dApp on its own origin ---
    await context.route(`${DAPP_ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<html><body>dapp</body></html>" }),
    );
    const dapp = await context.newPage();
    await dapp.goto(`${DAPP_ORIGIN}/`);

    // Connect: requires popup approval; returns the wallet address.
    const connectPromise = dapp.evaluate(() =>
      (window as never as { vela: { connect(n: string): Promise<unknown> } }).vela.connect(
        "testnet",
      ),
    );
    await approveInPopup(context, /approve/i);
    const connection = (await connectPromise) as { address: string; network: string };
    expect(connection.address).toBe(contractId);

    // Build a real transfer for the dApp to request signing on (node side,
    // plain stellar-sdk — the envelope is discarded by the sponsor path, only
    // the op + recorded auth entries matter).
    const {
      Address,
      Asset,
      BASE_FEE,
      Networks,
      nativeToScVal,
      Operation,
      rpc,
      TransactionBuilder,
    } = await import("@stellar/stellar-sdk");
    const server = new rpc.Server("https://soroban-testnet.stellar.org");
    const sourceAccount = await server.getAccount(funder.publicKey());
    const draft = new TransactionBuilder(sourceAccount, {
      fee: (Number(BASE_FEE) * 1000).toString(),
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: Asset.native().contractId(Networks.TESTNET),
          function: "transfer",
          args: [
            new Address(contractId).toScVal(),
            new Address(funder.publicKey()).toScVal(),
            nativeToScVal(15_000_000n, { type: "i128" }),
          ],
        }),
      )
      .setTimeout(30)
      .build();
    const xdr = (await server.prepareTransaction(draft)).toXDR();

    // Sign: one popup approval, then the DEVICE KEY signs — no passkey prompt.
    const signPromise = dapp.evaluate(
      (txXdr) =>
        (
          window as never as {
            vela: { signTransaction(i: { xdr: string; network: string }): Promise<unknown> };
          }
        ).vela.signTransaction({ xdr: txXdr, network: "testnet" }),
      xdr,
    );
    await approveInPopup(context, /approve/i);
    const { signedXdr } = (await signPromise) as { signedXdr: string };
    expect(signedXdr.length).toBeGreaterThan(100);

    // Submit through our backend (sponsor path) and confirm on-chain.
    const res = await fetch("http://localhost:4000/wallet/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedXdr, network: "testnet" }),
    });
    const body = (await res.json()) as { hash?: string; message?: string };
    expect(res.ok, `submit failed: ${JSON.stringify(body)}`).toBe(true);
    expect(body.hash).toBeTruthy();
    console.log("device-signer payment confirmed:", body.hash);
  } finally {
    await context.close();
  }
});
