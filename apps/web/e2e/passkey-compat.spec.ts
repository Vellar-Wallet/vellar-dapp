import { createHash, createPublicKey, createPrivateKey, verify, type KeyObject } from "node:crypto";
import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { normalizePasskeyError } from "@vellar/passkey";

// Browser compatibility suite for the first thing every user does: create a
// passkey, connect (discover it again) and sign (catcatching a WebAuthn
// assertion the wallet contract can verify). Catalogue 1.3, technical-doc.md §5.1.
//
// It runs on Chromium with the CDP WebAuthn VIRTUAL AUTHENTICATOR, so it needs no
// backend and no real authenticator (tagged @ci, safe for the mocked CI job). Safari,
// Firefox and mobile cannot be driven this way; they are covered by the manual
// checklist in docs/browser-compatibility-matrix.md, which repeats these same
// scenarios by hand.
//
// The ceremony options below MIRROR passkey-kit@0.14.0
// (dist/kit/webauthn-ops.js): ES256-only, residentKey/userVerification
// "preferred", random challenge. If the kit is upgraded, re-read that file.

const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";
// secp256r1 group order, for low-S normalisation of the compact signature.
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

const b64u = {
  encode: (buf: Buffer) => buf.toString("base64url"),
  decode: (s: string) => Buffer.from(s, "base64url"),
};

interface Authenticator {
  cdp: CDPSession;
  authenticatorId: string;
}

async function addAuthenticator(
  context: BrowserContext,
  page: Page,
  options: Record<string, unknown> = {},
): Promise<Authenticator> {
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
      ...options,
    },
  });
  return { cdp, authenticatorId };
}

async function credentials(a: Authenticator) {
  const { credentials } = await a.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: a.authenticatorId,
  });
  return credentials;
}

/** The P-256 public key for a virtual credential, derived from its PKCS8 private key. */
function publicKeyOf(privateKeyBase64: string): KeyObject {
  return createPublicKey(
    createPrivateKey({
      key: Buffer.from(privateKeyBase64, "base64"),
      format: "der",
      type: "pkcs8",
    }),
  );
}

/** Registration exactly as passkey-kit's createPasskey builds it. */
async function register(page: Page, overrides: Record<string, unknown> = {}, excludeId?: string) {
  return page.evaluate(
    async ({ over, excludeId }) => {
      const enc = (b: ArrayBuffer | Uint8Array) =>
        btoa(String.fromCharCode(...new Uint8Array(b)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      const dec = (s: string) =>
        Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
      const userId = rand(32);
      try {
        const cred = (await navigator.credentials.create({
          publicKey: {
            challenge: rand(32),
            rp: { id: "localhost", name: "Vellar e2e" },
            user: { id: userId, name: "e2e", displayName: "e2e" },
            authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
            pubKeyCredParams: [{ alg: -7, type: "public-key" }],
            timeout: 60_000,
            ...(excludeId
              ? { excludeCredentials: [{ id: dec(excludeId), type: "public-key" as const }] }
              : {}),
            ...over,
          } as PublicKeyCredentialCreationOptions,
        })) as PublicKeyCredential;
        return { ok: true as const, id: cred.id, userId: enc(userId) };
      } catch (e) {
        return { ok: false as const, name: (e as DOMException).name, userId: enc(userId) };
      }
    },
    { over: overrides, excludeId },
  );
}

/** Authentication as passkey-kit's authenticatePasskey (no allowCredentials) or a signing ceremony. */
async function authenticate(page: Page, opts: { allow?: string; challenge?: string } = {}) {
  return page.evaluate(async ({ allow, challenge }) => {
    const enc = (b: ArrayBuffer | Uint8Array) =>
      btoa(String.fromCharCode(...new Uint8Array(b)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const dec = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    try {
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge: challenge ? dec(challenge) : crypto.getRandomValues(new Uint8Array(32)),
          rpId: "localhost",
          userVerification: "preferred",
          timeout: 60_000,
          ...(allow ? { allowCredentials: [{ id: dec(allow), type: "public-key" as const }] } : {}),
        },
      })) as PublicKeyCredential;
      const r = cred.response as AuthenticatorAssertionResponse;
      return {
        ok: true as const,
        id: cred.id,
        authenticatorData: enc(r.authenticatorData),
        clientDataJSON: enc(r.clientDataJSON),
        signature: enc(r.signature),
        userHandle: r.userHandle ? enc(r.userHandle) : null,
      };
    } catch (e) {
      return { ok: false as const, name: (e as DOMException).name };
    }
  }, opts);
}

/** DER ECDSA signature -> {r, s} as bigints. */
function parseDerSignature(der: Buffer): { r: bigint; s: bigint } {
  let i = 2; // 0x30 len
  const readInt = () => {
    if (der[i++] !== 0x02) throw new Error("bad DER integer");
    const len = der[i++]!;
    const v = der.subarray(i, i + len);
    i += len;
    return BigInt("0x" + v.toString("hex"));
  };
  const r = readInt();
  const s = readInt();
  return { r, s };
}

test.describe("passkey compatibility on Chromium (virtual authenticator) @ci", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app");
  });

  test("a platform authenticator is detected", async ({ page, context }) => {
    await addAuthenticator(context, page);
    const available = await page.evaluate(() =>
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
    );
    expect(available).toBe(true);
  });

  test("create: an ES256 resident credential registers on the page's rpId", async ({
    page,
    context,
  }) => {
    const auth = await addAuthenticator(context, page);

    const result = await register(page);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [stored] = await credentials(auth);
    expect(stored).toBeDefined();
    expect(b64u.encode(Buffer.from(stored!.credentialId, "base64"))).toBe(result.id);
    expect(stored!.rpId).toBe(RP_ID);
    expect(stored!.isResidentCredential).toBe(true);
    // The user handle is what a discoverable sign-in hands back.
    expect(b64u.encode(Buffer.from(stored!.userHandle!, "base64"))).toBe(result.userId);
    const pub = publicKeyOf(stored!.privateKey);
    expect(pub.asymmetricKeyType).toBe("ec");
    expect(pub.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  test("connect: a discoverable sign-in finds the credential and its user handle", async ({
    page,
    context,
  }) => {
    const auth = await addAuthenticator(context, page);
    const created = await register(page);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = (await credentials(auth))[0]!.signCount;

    const assertion = await authenticate(page); // no allowCredentials

    expect(assertion.ok).toBe(true);
    if (!assertion.ok) return;
    expect(assertion.id).toBe(created.id);
    expect(assertion.userHandle).toBe(created.userId);
    expect((await credentials(auth))[0]!.signCount).toBeGreaterThan(before);
  });

  test("connect: with two passkeys the authenticator still returns one of them", async ({
    page,
    context,
  }) => {
    await addAuthenticator(context, page);
    const a = await register(page);
    const b = await register(page);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const assertion = await authenticate(page);

    expect(assertion.ok).toBe(true);
    if (!assertion.ok) return;
    expect([a.id, b.id]).toContain(assertion.id);
  });

  test("sign: the assertion verifies over authData || SHA-256(clientData) and echoes the challenge", async ({
    page,
    context,
  }) => {
    const auth = await addAuthenticator(context, page);
    const created = await register(page);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const challenge = createHash("sha256").update("a soroban auth payload").digest();

    const assertion = await authenticate(page, {
      allow: created.id,
      challenge: b64u.encode(challenge),
    });

    expect(assertion.ok).toBe(true);
    if (!assertion.ok) return;
    const clientData = JSON.parse(b64u.decode(assertion.clientDataJSON).toString("utf8"));
    expect(clientData.type).toBe("webauthn.get");
    expect(clientData.origin).toBe(ORIGIN);
    expect(clientData.challenge).toBe(b64u.encode(challenge));

    const authData = b64u.decode(assertion.authenticatorData);
    const signedData = Buffer.concat([
      authData,
      createHash("sha256").update(b64u.decode(assertion.clientDataJSON)).digest(),
    ]);
    const der = b64u.decode(assertion.signature);
    const publicKey = publicKeyOf((await credentials(auth))[0]!.privateKey);
    expect(verify("sha256", signedData, { key: publicKey, dsaEncoding: "der" }, der)).toBe(true);

    // rpIdHash binds the assertion to this RP; the user-present flag is set.
    expect(authData.subarray(0, 32).equals(createHash("sha256").update(RP_ID).digest())).toBe(true);
    expect(authData[32]! & 0x01).toBe(0x01);
  });

  test("sign: the signature converts to the 64-byte low-S compact form the wallet contract consumes", async ({
    page,
    context,
  }) => {
    const auth = await addAuthenticator(context, page);
    const created = await register(page);
    if (!created.ok) throw new Error("registration failed");
    const assertion = await authenticate(page, { allow: created.id });
    if (!assertion.ok) throw new Error("assertion failed");

    const { r, s } = parseDerSignature(b64u.decode(assertion.signature));
    const lowS = s > P256_N / 2n ? P256_N - s : s;
    const compact = Buffer.concat([
      Buffer.from(r.toString(16).padStart(64, "0"), "hex"),
      Buffer.from(lowS.toString(16).padStart(64, "0"), "hex"),
    ]);
    expect(compact).toHaveLength(64);

    const authData = b64u.decode(assertion.authenticatorData);
    const signedData = Buffer.concat([
      authData,
      createHash("sha256").update(b64u.decode(assertion.clientDataJSON)).digest(),
    ]);
    const publicKey = publicKeyOf((await credentials(auth))[0]!.privateKey);
    expect(
      verify("sha256", signedData, { key: publicKey, dsaEncoding: "ieee-p1363" }, compact),
    ).toBe(true);
  });

  test("sign: each ceremony increments the counter", async ({ page, context }) => {
    const auth = await addAuthenticator(context, page);
    const created = await register(page);
    if (!created.ok) throw new Error("registration failed");

    await authenticate(page, { allow: created.id });
    const first = (await credentials(auth))[0]!.signCount;
    await authenticate(page, { allow: created.id });
    const second = (await credentials(auth))[0]!.signCount;

    expect(second).toBeGreaterThan(first);
  });

  test("failure: a duplicate registration is InvalidStateError, mapped to credential-exists", async ({
    page,
    context,
  }) => {
    await addAuthenticator(context, page);
    const created = await register(page);
    if (!created.ok) throw new Error("registration failed");

    const again = await register(page, {}, created.id);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.name).toBe("InvalidStateError");
    expect(normalizePasskeyError({ name: again.name }).code).toBe("credential-exists");
  });

  test("failure: user verification required but not performed is NotAllowedError", async ({
    page,
    context,
  }) => {
    await addAuthenticator(context, page, { isUserVerified: false });

    const result = await register(page, {
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.name).toBe("NotAllowedError");
    expect(normalizePasskeyError({ name: result.name }).code).toBe("cancelled");
  });

  test("limitation: an unsatisfiable algorithm list is NotAllowedError, indistinguishable from a cancel", async ({
    page,
    context,
  }) => {
    await addAuthenticator(context, page);

    // -9999 is no COSE algorithm any authenticator implements (the virtual one does
    // support RS256, so -257 would succeed and prove nothing).
    const result = await register(page, { pubKeyCredParams: [{ alg: -9999, type: "public-key" }] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // FINDING: Chromium reports "nothing can satisfy these parameters" as
    // NotAllowedError, not NotSupportedError, so the browser hides it from the page.
    // passkey-kit is ES256-only, so an authenticator without ES256 would surface in
    // the app as "cancelled" rather than "unsupported". Authenticators without ES256
    // are rare; this test pins the behaviour so a browser change is noticed.
    expect(result.name).toBe("NotAllowedError");
    expect(normalizePasskeyError({ name: result.name }).code).toBe("cancelled");
  });

  test("failure: a ceremony the user abandons rejects with AbortError", async ({
    page,
    context,
  }) => {
    // No automatic presence: the ceremony waits for a touch that never comes.
    await addAuthenticator(context, page, { automaticPresenceSimulation: false });

    const result = await page.evaluate(async () => {
      const controller = new AbortController();
      const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
      setTimeout(() => controller.abort(), 500);
      try {
        await navigator.credentials.create({
          signal: controller.signal,
          publicKey: {
            challenge: rand(32),
            rp: { id: "localhost", name: "Vellar e2e" },
            user: { id: rand(32), name: "e2e", displayName: "e2e" },
            pubKeyCredParams: [{ alg: -7, type: "public-key" }],
            timeout: 60_000,
          },
        });
        return "resolved";
      } catch (e) {
        return (e as DOMException).name;
      }
    });

    expect(result).toBe("AbortError");
    expect(normalizePasskeyError({ name: result }).code).toBe("aborted");
  });
});

test.describe("the real onboarding page drives the real kit @ci", () => {
  test("the page offers both actions in a secure context with no unsupported banner", async ({
    page,
    context,
  }) => {
    await addAuthenticator(context, page);
    await page.goto("/app");

    await expect(page.getByRole("button", { name: "Create wallet" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
    await expect(page.getByText(/passkeys? (are|is) not supported|secure context/i)).toHaveCount(0);
  });

  test("Create wallet runs a real WebAuthn registration, and a dead backend ends in a usable error, not a hang", async ({
    page,
    context,
  }) => {
    const auth = await addAuthenticator(context, page);
    // Nothing past the passkey ceremony may succeed: block the backend and the RPC.
    await page.route(/\/wallet\//, (route) => route.abort("connectionrefused"));
    await page.route(/soroban|stellar\.org|sorobanrpc/, (route) =>
      route.abort("connectionrefused"),
    );
    await page.goto("/app");

    await page.getByRole("button", { name: "Create wallet" }).click();

    // The kit reached the browser and a credential now exists on the authenticator.
    await expect.poll(async () => (await credentials(auth)).length, { timeout: 30_000 }).toBe(1);
    // And the UI recovers: the action is available again instead of spinning forever.
    await expect(page.getByRole("button", { name: "Create wallet" })).toBeEnabled({
      timeout: 60_000,
    });
    await expect(page).not.toHaveURL(/\/dashboard/);
  });

  test("Sign in runs a real discoverable assertion and sends that credential's id to the backend", async ({
    page,
    context,
  }) => {
    const auth = await addAuthenticator(context, page);
    await page.goto("/app");
    const created = await register(page);
    if (!created.ok) throw new Error("registration failed");

    const connectRequests: Array<Record<string, unknown>> = [];
    await page.route(/\/wallet\/connect/, async (route) => {
      connectRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "wallet_not_found" }),
      });
    });
    const before = (await credentials(auth))[0]!.signCount;

    await page.getByRole("button", { name: "Sign in" }).click();

    await expect.poll(() => connectRequests.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(connectRequests[0]!.keyId).toBe(created.id);
    expect((await credentials(auth))[0]!.signCount).toBeGreaterThan(before);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled({ timeout: 30_000 });
  });
});
