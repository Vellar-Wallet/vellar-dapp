import { describe, expect, it } from "vitest";
import { FacilitatorUrlError, facilitatorUrlFromEnv } from "./facilitator-url";

// The x402 facilitator URL is configuration, not code. It used to be a string
// literal inside lifecycle- and verification-service, so retiring a host meant
// editing source and a missing setting silently fell back to whatever was baked
// in. Now an unset or unusable FACILITATOR_URL refuses to boot, like
// publicBaseUrlFromEnv does for the public base URL.

const RAILWAY = "https://vellar-facilitator-production.up.railway.app";

describe("facilitatorUrlFromEnv", () => {
  it("returns a valid https URL", () => {
    expect(facilitatorUrlFromEnv({ FACILITATOR_URL: RAILWAY })).toBe(RAILWAY);
  });

  it("strips a trailing slash so callers can append paths", () => {
    expect(facilitatorUrlFromEnv({ FACILITATOR_URL: `${RAILWAY}/` })).toBe(RAILWAY);
    expect(facilitatorUrlFromEnv({ FACILITATOR_URL: `${RAILWAY}///` })).toBe(RAILWAY);
  });

  it("keeps a path prefix (a facilitator mounted under a path)", () => {
    expect(facilitatorUrlFromEnv({ FACILITATOR_URL: "https://x402.example.com/v2/" })).toBe(
      "https://x402.example.com/v2",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(facilitatorUrlFromEnv({ FACILITATOR_URL: `  ${RAILWAY}\n` })).toBe(RAILWAY);
  });

  describe("refuses to boot instead of defaulting", () => {
    it.each([[undefined], [""], ["   "]])("when FACILITATOR_URL is %j", (value) => {
      const env = value === undefined ? {} : { FACILITATOR_URL: value };
      expect(() => facilitatorUrlFromEnv(env)).toThrow(FacilitatorUrlError);
      expect(() => facilitatorUrlFromEnv(env)).toThrow(/FACILITATOR_URL is not set/);
    });

    it("names the setting and the refusal so the boot log is actionable", () => {
      expect(() => facilitatorUrlFromEnv({})).toThrow(/refus/i);
    });
  });

  describe("rejects URLs that cannot be a facilitator", () => {
    it.each([["not a url"], ["//no-scheme.example.com"], ["vellar-facilitator.example.com"]])(
      "an unparseable value: %j",
      (value) => {
        expect(() => facilitatorUrlFromEnv({ FACILITATOR_URL: value })).toThrow(
          FacilitatorUrlError,
        );
      },
    );

    it.each([["http://facilitator.example.com"], ["ftp://facilitator.example.com"]])(
      "a non-https scheme in production: %s",
      (value) => {
        expect(() =>
          facilitatorUrlFromEnv({ FACILITATOR_URL: value, NODE_ENV: "production" }),
        ).toThrow(/https/);
      },
    );

    it("embedded credentials", () => {
      expect(() =>
        facilitatorUrlFromEnv({ FACILITATOR_URL: "https://user:pw@facilitator.example.com" }),
      ).toThrow(/credentials/);
    });

    it("a query string or fragment (almost certainly a pasted browser URL)", () => {
      expect(() => facilitatorUrlFromEnv({ FACILITATOR_URL: `${RAILWAY}?x=1` })).toThrow(
        /query|fragment/,
      );
      expect(() => facilitatorUrlFromEnv({ FACILITATOR_URL: `${RAILWAY}#top` })).toThrow(
        /query|fragment/,
      );
    });

    it("does not echo a secret that was pasted into the URL", () => {
      let message = "";
      try {
        facilitatorUrlFromEnv({
          FACILITATOR_URL: "https://user:hunter2secret@facilitator.example.com",
        });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toContain("hunter2secret");
    });
  });

  describe("Render is retired", () => {
    it.each([
      ["https://vellar-facilitator.onrender.com"],
      ["https://VELLAR-FACILITATOR.ONRENDER.COM"],
      ["https://anything.onrender.com/path"],
    ])("rejects %s", (value) => {
      expect(() => facilitatorUrlFromEnv({ FACILITATOR_URL: value })).toThrow(/Render/);
    });

    it("does not reject a host that merely contains the word", () => {
      expect(facilitatorUrlFromEnv({ FACILITATOR_URL: "https://onrender.example.com" })).toBe(
        "https://onrender.example.com",
      );
    });
  });

  describe("local development", () => {
    it.each([["http://localhost:4000"], ["http://127.0.0.1:4000"], ["http://[::1]:4000"]])(
      "allows plain http to loopback outside production: %s",
      (value) => {
        expect(facilitatorUrlFromEnv({ FACILITATOR_URL: value, NODE_ENV: "development" })).toBe(
          value,
        );
        expect(facilitatorUrlFromEnv({ FACILITATOR_URL: value })).toBe(value); // NODE_ENV unset
      },
    );

    it("refuses plain-http loopback in production", () => {
      expect(() =>
        facilitatorUrlFromEnv({ FACILITATOR_URL: "http://localhost:4000", NODE_ENV: "production" }),
      ).toThrow(/https/);
    });

    it("refuses plain http to a non-loopback host even in development", () => {
      expect(() =>
        facilitatorUrlFromEnv({
          FACILITATOR_URL: "http://facilitator.example.com",
          NODE_ENV: "development",
        }),
      ).toThrow(/https/);
    });
  });
});

// Source guard: the two services that talk to the facilitator must take its URL
// from configuration. A string literal in either would put the retired host (or
// any host) back into code, and nothing else would notice.
describe("lifecycle and verification services take the facilitator URL from config", async () => {
  const { readFileSync } = await import("node:fs");
  it.each(["lifecycle-service", "verification-service"])("%s", (service) => {
    const source = readFileSync(
      new URL(`../../../services/${service}/src/server.ts`, import.meta.url),
      "utf8",
    );
    expect(source).toContain("facilitatorUrlFromEnv(");
    expect(source).not.toMatch(/HTTPFacilitatorClient\(\{\s*url:\s*["'`]/);
    expect(source).not.toMatch(/up\.railway\.app/);
    expect(source).not.toMatch(/onrender\.com/);
  });
});
