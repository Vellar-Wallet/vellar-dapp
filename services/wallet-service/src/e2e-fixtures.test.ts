import { createECDH, createPrivateKey, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { xdr, Address } from "@stellar/stellar-sdk";
import { PasskeyClient } from "passkey-kit";
import { describe, expect, it } from "vitest";
import { defaultDeployerPublicKey, deriveWalletContractId } from "./derivation";
import { createMemoryWalletRepository } from "./repository";
import { createUnconfiguredSubmitter } from "./relayer";
import { buildServer } from "./server";

// Source of truth for the web app's mocked "reconnect" e2e fixtures
// (apps/web/e2e/fixtures/reconnect.json, consumed by
// apps/web/e2e/reconnect.spec.ts).
//
// security-audit.md RA-9: nothing in that file is hand-shaped.
//   - The wallet address is passkey-kit's own deterministic derivation.
//   - The on-chain entries the kit reads during connectWallet (wallet instance
//     + the passkey's SignerVal) are encoded with the wallet contract's own
//     Spec from passkey-kit, and decoded back below the way kit.getSigner does.
//   - /wallet/connect and /wallet/sessions responses are captured from the real
//     wallet-service buildServer (real rate limiter, real 404, real bearer
//     check); only the relayer is absent, which these routes never touch.
//   - The passkey is a real P-256 key the virtual authenticator signs with.
//
// DRIFT GUARD: if any of the above changes (kit encoding, derivation, route
// shapes), this fails until the fixture is regenerated with
//   UPDATE_E2E_FIXTURES=1 pnpm --filter @vellar/wallet-service test e2e-fixtures

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/e2e/fixtures/reconnect.json",
);
const PASSPHRASE = "Test SDF Network ; September 2015";
// apps/web/lib/config.ts DEFAULT_WALLET_WASM_HASH (the wallet the web app deploys).
const WALLET_WASM_HASH = "fdefad64b96837147e1c333e51f537b696eab925e9f147e63d597c04e3c903f0";
const FIXED_NOW = new Date("2026-09-26T12:00:00.000Z");

const SIGNER_KEY_UDT = xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: "SignerKey" }));
const SIGNER_VAL_UDT = xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: "SignerVal" }));

/** A deterministic P-256 passkey (test-only key; never used anywhere real). */
function testPasskey() {
  const d = createHash("sha256").update("vellar-e2e-reconnect-passkey").digest();
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const publicKey = ecdh.getPublicKey(); // 65-byte uncompressed point, as the wallet stores it
  const privateKey = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: d.toString("base64url"),
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33, 65).toString("base64url"),
    },
  });
  const credentialId = createHash("sha256").update("vellar-e2e-reconnect-credential").digest();
  return {
    credentialId,
    publicKey,
    pkcs8: privateKey.export({ format: "der", type: "pkcs8" }) as Buffer,
  };
}

function contractDataEntry(contractId: string, key: xdr.ScVal, val: xdr.ScVal) {
  const contract = Address.fromString(contractId).toScAddress();
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract,
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const data = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract,
      key,
      durability: xdr.ContractDataDurability.persistent(),
      val,
    }),
  );
  return { key: ledgerKey.toXDR("base64"), xdr: data.toXDR("base64") };
}

async function buildFixture() {
  const passkey = testPasskey();
  const keyId = passkey.credentialId.toString("base64url");
  const wallet = deriveWalletContractId(keyId, { networkPassphrase: PASSPHRASE });
  const spec = new PasskeyClient({
    contractId: wallet,
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: PASSPHRASE,
  }).spec;

  const walletInstance = contractDataEntry(
    wallet,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    xdr.ScVal.scvContractInstance(
      new xdr.ScContractInstance({
        executable: xdr.ContractExecutable.contractExecutableWasm(
          Buffer.from(WALLET_WASM_HASH, "hex"),
        ),
        storage: null,
      }),
    ),
  );
  // What the wallet's __constructor stores for the creating passkey:
  // SignerVal::Secp256r1(public_key, expiration: None, limits: None), Persistent
  // (passkey-kit deploy-ops buildDeployTransaction).
  const passkeySigner = contractDataEntry(
    wallet,
    spec.nativeToScVal({ tag: "Secp256r1", values: [passkey.credentialId] }, SIGNER_KEY_UDT),
    spec.nativeToScVal(
      { tag: "Secp256r1", values: [passkey.publicKey, [undefined], [undefined]] },
      SIGNER_VAL_UDT,
    ),
  );

  // Real wallet-service: a wallet created by this passkey, then reconnect.
  const wallets = createMemoryWalletRepository();
  await wallets.insert({
    keyId,
    contractId: wallet,
    network: "testnet",
    createdAt: FIXED_NOW.toISOString(),
  });
  const app = buildServer({
    submitter: createUnconfiguredSubmitter(),
    wallets,
    now: () => FIXED_NOW,
    passkeyRateLimitMax: 1,
  });
  await app.ready();
  const call = async (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => {
    const res = await app.inject({ method, url, payload: payload as never, headers });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  const connectOk = await call("POST", "/wallet/connect", { keyId, network: "testnet" });
  const sessionId = connectOk.body.sessionId as string;
  const sessions = await call(
    "GET",
    `/wallet/sessions?contractId=${wallet}&network=testnet`,
    undefined,
    { authorization: `Bearer ${sessionId}` },
  );
  // Second attempt inside the window with max=1 → the real 429.
  const connectRateLimited = await call("POST", "/wallet/connect", { keyId, network: "testnet" });
  const unknownKeyId = createHash("sha256").update("not-a-vellar-passkey").digest("base64url");
  const connectNotFound = await call("POST", "/wallet/connect", {
    keyId: unknownKeyId,
    network: "testnet",
  });
  await app.close();

  const stable = <T>(v: T): T =>
    JSON.parse(JSON.stringify(v).replaceAll(sessionId, "e2e-session-id")) as T;

  return {
    _generatedBy:
      "services/wallet-service/src/e2e-fixtures.test.ts (passkey-kit derivation + Spec, real buildServer; regenerate with UPDATE_E2E_FIXTURES=1)",
    wallet,
    keyId,
    deployerPublicKey: defaultDeployerPublicKey(),
    // CDP WebAuthn.addCredential input (binary fields are base64).
    credential: {
      credentialId: passkey.credentialId.toString("base64"),
      privateKey: passkey.pkcs8.toString("base64"),
      rpId: "localhost",
      userHandle: Buffer.from("vellar-e2e-user").toString("base64"),
      isResidentCredential: true,
      signCount: 0,
    },
    ledger: { walletInstance, passkeySigner },
    connectOk: stable(connectOk),
    sessions: stable(sessions),
    connectRateLimited,
    connectNotFound,
  };
}

describe("apps/web e2e reconnect fixtures (RA-9: derived from passkey-kit + real wallet-service)", () => {
  it("the fixture file matches what the kit and the real routes produce today", async () => {
    const fresh = await buildFixture();

    // Sanity: the outcomes the e2e relies on.
    expect(fresh.connectOk).toEqual({
      status: 200,
      body: { contractId: fresh.wallet, sessionId: "e2e-session-id" },
    });
    expect(fresh.sessions.status).toBe(200);
    expect(fresh.connectRateLimited.status).toBe(429);
    expect(fresh.connectNotFound).toEqual({ status: 404, body: { error: "wallet_not_found" } });

    // The signer entry decodes the way kit.getSigner reads it (wallet-ops.js).
    const spec = new PasskeyClient({
      contractId: fresh.wallet,
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: PASSPHRASE,
    }).spec;
    const stored = xdr.LedgerEntryData.fromXDR(fresh.ledger.passkeySigner.xdr, "base64")
      .contractData()
      .val();
    const native = spec.scValToNative(stored, SIGNER_VAL_UDT) as { tag: string; values: unknown[] };
    expect(native.tag).toBe("Secp256r1");
    expect(Buffer.from(native.values[0] as Buffer).toString("base64")).toBe(
      testPasskey().publicKey.toString("base64"),
    );

    if (process.env.UPDATE_E2E_FIXTURES === "1") {
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(fresh, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))).toEqual(fresh);
  });
});
