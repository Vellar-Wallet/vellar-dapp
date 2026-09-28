import { describe, expect, it } from "vitest";
import {
  publicBaseUrlFromEnv,
  validatePublicResourceUrl,
  X402ResourceUrlError,
} from "./x402-resource-url";

// This guard exists because /lifecycle/execute registered "http://localhost:4002/..."
// in the public mainnet Bazaar catalog — unreachable for every consumer, and a
// real duplicate-payout risk. Every rejection case below is a variant of "this
// URL would repeat that incident."

describe("validatePublicResourceUrl", () => {
  it("accepts a valid public https URL", () => {
    expect(() =>
      validatePublicResourceUrl("https://vellar-backend.onrender.com/lifecycle/execute", {
        requireHttps: true,
      }),
    ).not.toThrow();
  });

  it("accepts http when requireHttps is false", () => {
    expect(() =>
      validatePublicResourceUrl("http://example.com/resource", { requireHttps: false }),
    ).not.toThrow();
  });

  it("rejects an empty URL", () => {
    expect(() => validatePublicResourceUrl("", { requireHttps: true })).toThrow(
      X402ResourceUrlError,
    );
  });

  it("rejects a relative/non-absolute URL", () => {
    expect(() => validatePublicResourceUrl("/lifecycle/execute", { requireHttps: true })).toThrow(
      X402ResourceUrlError,
    );
  });

  it("rejects an unsupported scheme", () => {
    expect(() =>
      validatePublicResourceUrl("ftp://example.com/resource", { requireHttps: true }),
    ).toThrow(X402ResourceUrlError);
  });

  it("rejects http when requireHttps is true (stellar:pubnet must be https)", () => {
    expect(() =>
      validatePublicResourceUrl("http://vellar-backend.onrender.com/lifecycle/execute", {
        requireHttps: true,
      }),
    ).toThrow(X402ResourceUrlError);
  });

  // The exact bug that shipped: getUrl() derived this from the proxy's
  // internal bind address.
  it("rejects localhost — the exact incident this guard prevents", () => {
    expect(() =>
      validatePublicResourceUrl("http://localhost:4002/lifecycle/execute", {
        requireHttps: false,
      }),
    ).toThrow(/loopback\/local/);
  });

  it("rejects 127.0.0.1", () => {
    expect(() =>
      validatePublicResourceUrl("http://127.0.0.1:4002/lifecycle/execute", {
        requireHttps: false,
      }),
    ).toThrow(X402ResourceUrlError);
  });

  it("rejects 0.0.0.0", () => {
    expect(() =>
      validatePublicResourceUrl("http://0.0.0.0:4002/lifecycle/execute", { requireHttps: false }),
    ).toThrow(X402ResourceUrlError);
  });

  it("rejects the IPv6 loopback (::1, with and without brackets)", () => {
    expect(() =>
      validatePublicResourceUrl("http://[::1]:4002/lifecycle/execute", { requireHttps: false }),
    ).toThrow(X402ResourceUrlError);
  });

  it("rejects a *.local hostname", () => {
    expect(() =>
      validatePublicResourceUrl("http://backend.local/lifecycle/execute", {
        requireHttps: false,
      }),
    ).toThrow(X402ResourceUrlError);
  });

  it("rejects a link-local IPv4 address (169.254.0.0/16)", () => {
    expect(() =>
      validatePublicResourceUrl("http://169.254.1.1/lifecycle/execute", { requireHttps: false }),
    ).toThrow(X402ResourceUrlError);
  });

  it("rejects a link-local IPv6 address (fe80::/10)", () => {
    expect(() =>
      validatePublicResourceUrl("http://[fe80::1]/lifecycle/execute", { requireHttps: false }),
    ).toThrow(X402ResourceUrlError);
  });

  it("rejects a bare hostname with no dot (e.g. a Docker/k8s service name)", () => {
    expect(() =>
      validatePublicResourceUrl("http://lifecycle-service/execute", { requireHttps: false }),
    ).toThrow(X402ResourceUrlError);
  });

  it.each(["10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1"])(
    "rejects the RFC1918 private address %s",
    (host) => {
      expect(() =>
        validatePublicResourceUrl(`http://${host}/lifecycle/execute`, { requireHttps: false }),
      ).toThrow(X402ResourceUrlError);
    },
  );

  it.each(["172.15.0.1", "172.32.0.1", "9.0.0.1", "193.168.1.1"])(
    "does NOT reject addresses that merely look adjacent to an RFC1918 range (%s)",
    (host) => {
      expect(() =>
        validatePublicResourceUrl(`https://${host}/lifecycle/execute`, { requireHttps: true }),
      ).not.toThrow();
    },
  );
});

describe("publicBaseUrlFromEnv", () => {
  it("throws when neither PUBLIC_BASE_URL nor RENDER_EXTERNAL_URL is set — no permissive fallback", () => {
    expect(() => publicBaseUrlFromEnv({})).toThrow(X402ResourceUrlError);
  });

  it("uses RENDER_EXTERNAL_URL when PUBLIC_BASE_URL is absent", () => {
    expect(
      publicBaseUrlFromEnv({ RENDER_EXTERNAL_URL: "https://vellar-backend.onrender.com" }),
    ).toBe("https://vellar-backend.onrender.com");
  });

  it("prefers an explicit PUBLIC_BASE_URL over RENDER_EXTERNAL_URL", () => {
    expect(
      publicBaseUrlFromEnv({
        PUBLIC_BASE_URL: "https://api.vellar.xyz",
        RENDER_EXTERNAL_URL: "https://vellar-backend.onrender.com",
      }),
    ).toBe("https://api.vellar.xyz");
  });

  it("strips a trailing slash", () => {
    expect(
      publicBaseUrlFromEnv({ RENDER_EXTERNAL_URL: "https://vellar-backend.onrender.com/" }),
    ).toBe("https://vellar-backend.onrender.com");
  });

  it("still rejects a loopback value even if someone sets it explicitly", () => {
    expect(() => publicBaseUrlFromEnv({ PUBLIC_BASE_URL: "http://localhost:4002" })).toThrow(
      X402ResourceUrlError,
    );
  });

  it("rejects a non-https RENDER_EXTERNAL_URL (defense in depth, though Render always gives https)", () => {
    expect(() =>
      publicBaseUrlFromEnv({ RENDER_EXTERNAL_URL: "http://vellar-backend.onrender.com" }),
    ).toThrow(X402ResourceUrlError);
  });
});
