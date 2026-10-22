// @vitest-environment node

import { Account, Keypair, MuxedAccount, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { assetsFor, nativeAsset } from "./assets";
import {
  buildPayUri,
  parsePayUri,
  sep7SignaturePayload,
  verifySep7Origin,
  type Sep7PayRequest,
} from "./sep7";

const C_ADDR = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const G_ADDR = "GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO";
const M_ADDR = new MuxedAccount(new Account(G_ADDR, "0"), "7").accountId();
const TESTNET = { network: "testnet", networkPassphrase: Networks.TESTNET } as const;
const MAINNET = { network: "mainnet", networkPassphrase: Networks.PUBLIC } as const;
const TP = encodeURIComponent(Networks.TESTNET);
const USDC = assetsFor("testnet")[1]!;

function parseOk(uri: string, ctx: typeof TESTNET | typeof MAINNET = TESTNET): Sep7PayRequest {
  const result = parsePayUri(uri, ctx);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.error}`);
  return result.request;
}

function parseCode(uri: unknown, ctx: typeof TESTNET | typeof MAINNET = TESTNET): string {
  const result = parsePayUri(uri, ctx);
  if (result.ok) throw new Error("expected rejection");
  return result.code;
}

describe("buildPayUri", () => {
  it("builds a bare request for a C-address, pinning the testnet passphrase", () => {
    expect(
      buildPayUri({ destination: C_ADDR, network: "testnet", networkPassphrase: Networks.TESTNET }),
    ).toBe(`web+stellar:pay?destination=${C_ADDR}&network_passphrase=${TP}`);
  });

  it("omits network_passphrase on mainnet (SEP-7 default network)", () => {
    expect(
      buildPayUri({ destination: C_ADDR, network: "mainnet", networkPassphrase: Networks.PUBLIC }),
    ).toBe(`web+stellar:pay?destination=${C_ADDR}`);
  });

  it("carries amount, classic asset, memo and msg, percent-encoded", () => {
    const uri = buildPayUri({
      destination: C_ADDR,
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      amount: "12.5",
      asset: USDC,
      memo: "inv #42 & co",
      msg: "pay me with lumens + usdc",
    });
    expect(uri).toBe(
      `web+stellar:pay?destination=${C_ADDR}&amount=12.5&asset_code=USDC&asset_issuer=${USDC.issuer}` +
        `&memo=inv%20%2342%20%26%20co&memo_type=MEMO_TEXT&msg=pay%20me%20with%20lumens%20%2B%20usdc` +
        `&network_passphrase=${TP}`,
    );
  });

  it("omits asset fields for the native asset", () => {
    const uri = buildPayUri({
      destination: C_ADDR,
      network: "mainnet",
      asset: nativeAsset("mainnet"),
      amount: "1",
    });
    expect(uri).toBe(`web+stellar:pay?destination=${C_ADDR}&amount=1`);
  });

  it.each(["0", "0.0", "-1", "1e3", "1.12345678", "abc", " 1", "01"])(
    "rejects invalid amount %j",
    (amount) => {
      expect(() => buildPayUri({ destination: C_ADDR, network: "testnet", amount })).toThrow(
        /Amount/,
      );
    },
  );

  it("rejects an invalid destination and oversized / unsafe memos", () => {
    expect(() => buildPayUri({ destination: "GBAD", network: "testnet" })).toThrow(/Destination/);
    expect(() =>
      buildPayUri({ destination: C_ADDR, network: "testnet", memo: "x".repeat(29) }),
    ).toThrow(/Memo/);
    expect(() =>
      buildPayUri({ destination: C_ADDR, network: "testnet", memo: "€€€€€€€€€€" }),
    ).toThrow(/Memo/);
    expect(() => buildPayUri({ destination: C_ADDR, network: "testnet", msg: "hi‮evil" })).toThrow(
      /Message/,
    );
  });

  it("round-trips through the parser (without memo)", () => {
    const uri = buildPayUri({
      destination: C_ADDR,
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      amount: "0.0000001",
      asset: USDC,
      msg: "coffee & cake",
    });
    expect(parseOk(uri)).toMatchObject({
      destination: C_ADDR,
      destinationKind: "contract",
      amount: "0.0000001",
      asset: USDC,
      msg: "coffee & cake",
    });
  });
});

describe("parsePayUri — valid requests", () => {
  it("accepts a C-address and a G-address destination", () => {
    expect(parseOk(`web+stellar:pay?destination=${C_ADDR}&network_passphrase=${TP}`)).toMatchObject(
      { destination: C_ADDR, destinationKind: "contract", asset: nativeAsset("testnet") },
    );
    expect(parseOk(`web+stellar:pay?destination=${G_ADDR}&network_passphrase=${TP}`)).toMatchObject(
      { destinationKind: "account" },
    );
  });

  it("defaults to XLM with no amount (payer chooses)", () => {
    const req = parseOk(`web+stellar:pay?destination=${C_ADDR}&network_passphrase=${TP}`);
    expect(req.amount).toBeUndefined();
    expect(req.asset.id).toBe("native");
  });

  it("accepts the SEP-7 spec example on mainnet (no passphrase), scheme case-insensitive", () => {
    const req = parseOk(
      `WEB+STELLAR:pay?destination=${G_ADDR}&amount=120.1234567&msg=pay%20me%20with%20lumens`,
      MAINNET,
    );
    expect(req).toMatchObject({ amount: "120.1234567", msg: "pay me with lumens" });
  });

  it("decodes + as a space in msg (form encoding)", () => {
    const req = parseOk(`web+stellar:pay?destination=${C_ADDR}&msg=a+b&network_passphrase=${TP}`);
    expect(req.msg).toBe("a b");
  });

  it("resolves a registered classic asset", () => {
    const req = parseOk(
      `web+stellar:pay?destination=${C_ADDR}&asset_code=USDC&asset_issuer=${USDC.issuer}&network_passphrase=${TP}`,
    );
    expect(req.asset).toBe(USDC);
  });
});

describe("parsePayUri — hostile and malformed requests", () => {
  const base = `web+stellar:pay?destination=${C_ADDR}&network_passphrase=${TP}`;

  it.each([
    [42, "not_a_string"],
    [`web+stellar:pay?destination=${C_ADDR}&msg=${"a".repeat(2100)}`, "too_long"],
    ["https://evil.example/pay?destination=" + C_ADDR, "bad_scheme"],
    ["stellar:pay?destination=" + C_ADDR, "bad_scheme"],
    [`web+stellar:tx?xdr=AAAA`, "unsupported_operation"],
    [`web+stellar:PAY?destination=${C_ADDR}`, "unsupported_operation"],
    [`web+stellar:pay`, "missing_destination"],
    [`web+stellar:pay?`, "missing_destination"],
    [`web+stellar:pay?amount=1&network_passphrase=${TP}`, "missing_destination"],
    [`${base}#frag`, "malformed"],
    [`${base}&amount`, "malformed"],
    [`${base}&=1`, "malformed"],
    [`${base}&msg=%E0%A4%A`, "malformed"],
    [`${base}&msg=%zz`, "malformed"],
    [`${base}&destination=${G_ADDR}`, "duplicate_param"],
    [`${base}&amount=1&amount=1000`, "duplicate_param"],
    [`${base}&xdr=AAAA`, "unknown_param"],
    [`${base}&pubkey=${G_ADDR}`, "unknown_param"],
    [`${base}&Amount=5`, "unknown_param"],
    [`web+stellar:pay?destination=GABC&network_passphrase=${TP}`, "invalid_destination"],
    [
      `web+stellar:pay?destination=${C_ADDR.toLowerCase()}&network_passphrase=${TP}`,
      "invalid_destination",
    ],
    [`web+stellar:pay?destination=${M_ADDR}&network_passphrase=${TP}`, "unsupported_destination"],
    [`${base}&amount=-5`, "invalid_amount"],
    [`${base}&amount=0`, "invalid_amount"],
    [`${base}&amount=1.12345678`, "invalid_amount"],
    [`${base}&amount=1e9`, "invalid_amount"],
    [`${base}&amount=1%2C000`, "invalid_amount"],
    [`${base}&amount=NaN`, "invalid_amount"],
    [`${base}&amount=9999999999999`, "invalid_amount"],
    [`${base}&amount=%201`, "invalid_amount"],
    [`${base}&asset_code=USDC`, "invalid_asset"],
    [`${base}&asset_issuer=${USDC.issuer}`, "invalid_asset"],
    [`${base}&asset_code=US%20DC&asset_issuer=${USDC.issuer}`, "invalid_asset"],
    [`${base}&asset_code=USDC&asset_issuer=notakey`, "invalid_asset"],
    [`${base}&asset_code=USDC&asset_issuer=${G_ADDR}`, "unregistered_asset"],
    [`${base}&asset_code=usdc&asset_issuer=${USDC.issuer}`, "unregistered_asset"],
    [`${base}&memo=123`, "memo_unsupported"],
    [`${base}&memo_type=MEMO_ID`, "memo_unsupported"],
    [`${base}&callback=url%3Ahttps%3A%2F%2Fevil.example`, "callback_unsupported"],
    [`web+stellar:pay?destination=${C_ADDR}`, "wrong_network"],
    [
      `web+stellar:pay?destination=${C_ADDR}&network_passphrase=${encodeURIComponent(Networks.PUBLIC)}`,
      "wrong_network",
    ],
    [`${base}&msg=%E2%80%AEreversed`, "unsafe_text"],
    [`${base}&msg=line%0Abreak`, "unsafe_text"],
    [`${base}&msg=${"m".repeat(301)}`, "unsafe_text"],
    [`${base}&origin_domain=example.com`, "invalid_origin"],
    [`${base}&signature=abc`, "invalid_origin"],
    [`${base}&origin_domain=localhost&signature=abc`, "invalid_origin"],
    [`${base}&origin_domain=10.0.0.1&signature=abc`, "invalid_origin"],
    [`${base}&origin_domain=evil.com%2Fpath&signature=abc`, "invalid_origin"],
    [`${base}&origin_domain=EXAMPLE.COM&signature=abc`, "invalid_origin"],
  ])("rejects %j as %s", (uri, code) => {
    expect(parseCode(uri)).toBe(code);
  });

  it("never renders markup from msg — it is returned verbatim as text", () => {
    const req = parseOk(`${base}&msg=${encodeURIComponent("<img src=x onerror=alert(1)>")}`);
    expect(req.msg).toBe("<img src=x onerror=alert(1)>");
  });

  it("does not coerce a mainnet asset onto testnet", () => {
    const mainUsdc = assetsFor("mainnet")[1]!;
    expect(parseCode(`${base}&asset_code=USDC&asset_issuer=${mainUsdc.issuer}`)).toBe(
      "unregistered_asset",
    );
  });
});

describe("verifySep7Origin", () => {
  const signer = Keypair.random();
  const toml = `VERSION="2.0.0"\nURI_REQUEST_SIGNING_KEY="${signer.publicKey()}"\n[[CURRENCIES]]\nURI_REQUEST_SIGNING_KEY="GIGNORED"\n`;

  function signedUri(extra = ""): string {
    const unsigned = `web+stellar:pay?destination=${C_ADDR}&amount=5${extra}&network_passphrase=${TP}&origin_domain=shop.example.com`;
    const sig = signer.sign(Buffer.from(sep7SignaturePayload(unsigned))).toString("base64");
    return `${unsigned}&signature=${encodeURIComponent(sig)}`;
  }

  const okFetch = vi.fn(async (_url: string) => ({ ok: true, text: async () => toml }));

  it("returns none when no origin is claimed", async () => {
    const req = parseOk(`web+stellar:pay?destination=${C_ADDR}&network_passphrase=${TP}`);
    await expect(verifySep7Origin(req, { fetch: okFetch })).resolves.toEqual({ status: "none" });
  });

  it("verifies a correctly signed request against the domain's stellar.toml", async () => {
    const req = parseOk(signedUri());
    await expect(verifySep7Origin(req, { fetch: okFetch })).resolves.toEqual({
      status: "verified",
      domain: "shop.example.com",
    });
    expect(okFetch).toHaveBeenCalledWith("https://shop.example.com/.well-known/stellar.toml");
  });

  it("rejects a tampered request", async () => {
    const tampered = signedUri().replace("amount=5", "amount=500");
    const result = await verifySep7Origin(parseOk(tampered), { fetch: okFetch });
    expect(result.status).toBe("invalid");
  });

  it("rejects a signature from a different key", async () => {
    const other = `VERSION="2.0.0"\nURI_REQUEST_SIGNING_KEY="${Keypair.random().publicKey()}"\n`;
    const result = await verifySep7Origin(parseOk(signedUri()), {
      fetch: async () => ({ ok: true, text: async () => other }),
    });
    expect(result.status).toBe("invalid");
  });

  it("rejects when stellar.toml is missing, unreachable, or has no signing key", async () => {
    const req = parseOk(signedUri());
    for (const fetch of [
      async () => ({ ok: false, text: async () => "" }),
      async () => {
        throw new Error("offline");
      },
      async () => ({ ok: true, text: async () => `VERSION="2.0.0"\n` }),
    ]) {
      expect((await verifySep7Origin(req, { fetch })).status).toBe("invalid");
    }
  });

  it("rejects when the signature is not the last field", async () => {
    const uri = signedUri() + "&msg=late";
    expect((await verifySep7Origin(parseOk(uri), { fetch: okFetch })).status).toBe("invalid");
  });

  it("alerts when the domain's signing key changed since last time", async () => {
    const store = new Map<string, string>([["shop.example.com", Keypair.random().publicKey()]]);
    const keyCache = {
      get: (d: string) => store.get(d) ?? null,
      set: (d: string, k: string) => store.set(d, k),
    };
    const result = await verifySep7Origin(parseOk(signedUri()), { fetch: okFetch, keyCache });
    expect(result).toMatchObject({ status: "invalid", reason: expect.stringMatching(/changed/) });
  });

  it("remembers the signing key after a successful verification", async () => {
    const store = new Map<string, string>();
    const keyCache = {
      get: (d: string) => store.get(d) ?? null,
      set: (d: string, k: string) => store.set(d, k),
    };
    await verifySep7Origin(parseOk(signedUri()), { fetch: okFetch, keyCache });
    expect(store.get("shop.example.com")).toBe(signer.publicKey());
  });

  // Issue #558: origin-domain signature validation end to end — a crafted URI
  // must not be able to spoof a trusted origin in the UI.
  it("treats a URI with no origin/signature fields as unverified, not silently trusted", async () => {
    const req = parseOk(`web+stellar:pay?destination=${C_ADDR}&network_passphrase=${TP}`);
    expect(req.originDomain).toBeUndefined();
    expect(req.signature).toBeUndefined();
    await expect(verifySep7Origin(req, { fetch: okFetch })).resolves.toEqual({ status: "none" });
  });

  it("rejects a URI whose signature does not match its declared origin domain", async () => {
    // Same declared origin, signature over different bytes → invalid, and the
    // pay route must refuse it (see app/pay/page.tsx).
    const forged = signedUri().replace("amount=5", "amount=5000");
    const result = await verifySep7Origin(parseOk(forged), { fetch: okFetch });
    expect(result).toMatchObject({ status: "invalid", domain: "shop.example.com" });
  });

  it("rejects a URI whose origin's signing key cannot be resolved", async () => {
    const result = await verifySep7Origin(parseOk(signedUri()), {
      fetch: async () => ({ ok: true, text: async () => `VERSION="2.0.0"\n` }),
    });
    expect(result.status).toBe("invalid");
  });
});
