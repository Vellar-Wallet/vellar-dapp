import { describe, expect, it } from "vitest";
import {
  SigningKeyConfigError,
  redactRelayerUrl,
  signingKeyFromEnv,
  verifySigningKeys,
} from "./signing-keys";

// Any derivation works for these tests: the secret "S<name>" signs as "G<name>".
const derivePublicKey = (secret: string) => {
  if (!secret.startsWith("S")) throw new Error("not a seed");
  return `G${secret.slice(1)}`;
};

describe("redactRelayerUrl (#755)", () => {
  it("drops credentials, query string and fragment but keeps scheme, host and path", () => {
    expect(
      redactRelayerUrl("https://svc:topsecret@relay.example.com:8443/testnet/v1?api_key=abc#frag"),
    ).toBe("https://relay.example.com:8443/testnet/v1");
  });

  it("leaves a clean URL unchanged apart from normalization", () => {
    expect(redactRelayerUrl("https://channels.openzeppelin.com/testnet")).toBe(
      "https://channels.openzeppelin.com/testnet",
    );
  });

  it("never echoes an unparseable value", () => {
    expect(redactRelayerUrl("not a url with secret-123")).toBe("<unparseable URL>");
  });
});

describe("verifySigningKeys error messages (#755)", () => {
  const base = { network: "mainnet" as const, derivePublicKey, allowUnpinned: true };

  it("names the relayer URL without its credentials or query string", () => {
    const relayerBaseUrl = "https://svc:KEY-123@relay.example.com/testnet/v1?api_key=KEY-123";
    const run = () => verifySigningKeys({ ...base, keys: [], relayerBaseUrl });

    expect(run).toThrow(SigningKeyConfigError);
    expect(run).toThrow("https://relay.example.com/testnet/v1");
    try {
      run();
    } catch (err) {
      expect((err as Error).message).not.toContain("KEY-123");
    }
  });

  it("does not echo an invalid secret seed", () => {
    const env = { SPONSOR_SECRET_KEY: "definitely-not-a-seed-77", SPONSOR_PUBLIC_KEY: "" };
    try {
      verifySigningKeys({ ...base, keys: [signingKeyFromEnv("sponsor", env)] });
      throw new Error("expected verifySigningKeys to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SigningKeyConfigError);
      expect((err as Error).message).toContain("SPONSOR_SECRET_KEY is not a valid Stellar secret");
      expect((err as Error).message).not.toContain("definitely-not-a-seed-77");
    }
  });

  it("does not echo the secret when the pinned public key does not match", () => {
    const env = { SPONSOR_SECRET_KEY: "SAAAA-secret-seed", SPONSOR_PUBLIC_KEY: "GBBBB" };
    try {
      verifySigningKeys({ ...base, keys: [signingKeyFromEnv("sponsor", env)] });
      throw new Error("expected verifySigningKeys to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("GAAAA-secret-seed"); // the derived PUBLIC key is fine to print
      expect(message).toContain("GBBBB");
      expect(message).not.toContain("SAAAA-secret-seed");
    }
  });
});
