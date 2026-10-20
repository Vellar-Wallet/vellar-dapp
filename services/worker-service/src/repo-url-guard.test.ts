import { describe, expect, it } from "vitest";
import {
  ALLOWED_HTTPS_PORTS,
  assertPublicHttpsRepoUrl,
  gitConnectionPinArgs,
  isBlockedAddress,
  parseHttpsRepoUrl,
  RepoUrlError,
} from "./repo-url-guard";

describe("parseHttpsRepoUrl — syntactic scheme/shape checks (no DNS)", () => {
  it("accepts a normal https git URL", () => {
    const u = parseHttpsRepoUrl("https://github.com/vellar/wallet.git");
    expect(u.hostname).toBe("github.com");
  });

  it.each([
    ["file:///etc/passwd"],
    ["git://internal/repo"],
    ["ssh://git@internal/repo"],
    ["http://github.com/x"], // plain http rejected — https only
    ["ext::sh -c whoami"],
    ["-oProxyCommand=evil"], // cannot even parse as a URL
  ])("rejects non-https / dangerous scheme: %s", (url) => {
    expect(() => parseHttpsRepoUrl(url)).toThrow(RepoUrlError);
  });

  it("rejects a URL with embedded credentials (userinfo)", () => {
    expect(() => parseHttpsRepoUrl("https://user:pass@github.com/x")).toThrow(RepoUrlError);
  });

  it.each([
    ["Redis internal port", "https://github.com:6379/vellar/wallet.git"],
    ["Postgres internal port", "https://github.com:5432/vellar/wallet.git"],
    ["Docker daemon port", "https://github.com:2375/vellar/wallet.git"],
    ["Prometheus metrics port", "https://github.com:9090/vellar/wallet.git"],
    ["Internal HTTP port", "https://github.com:8080/vellar/wallet.git"],
    ["SSH port over https scheme", "https://github.com:22/vellar/wallet.git"],
  ])("deliberately rejects an allowed host with %s (%s)", (_label, url) => {
    expect(ALLOWED_HTTPS_PORTS.has(443)).toBe(true);
    expect(ALLOWED_HTTPS_PORTS.has(8443)).toBe(true);
    expect(() => parseHttpsRepoUrl(url)).toThrow(RepoUrlError);
  });

  it.each([
    ["IPv6 loopback with Redis port", "https://[::1]:6379/vellar/wallet.git"],
    [
      "IPv6 mapped loopback with Postgres port",
      "https://[::ffff:127.0.0.1]:5432/vellar/wallet.git",
    ],
    [
      "Public IPv6 literal with internal port",
      "https://[2606:2800:220:1:248:1893:25c8:1946]:6379/vellar/wallet.git",
    ],
  ])("rejects IPv6 literal with non-standard port: %s (%s)", (_label, url) => {
    expect(() => parseHttpsRepoUrl(url)).toThrow(RepoUrlError);
  });
});

describe("isBlockedAddress — private / loopback / link-local ranges", () => {
  it.each([
    ["127.0.0.1"],
    ["0.0.0.0"],
    ["10.1.2.3"],
    ["100.64.0.1"], // CGNAT shared space
    ["172.16.5.4"],
    ["192.168.1.1"],
    ["169.254.169.254"], // cloud metadata
    ["::1"], // ipv6 loopback
    ["[::1]"], // bracketed ipv6 loopback
    ["0:0:0:0:0:0:0:1"], // expanded ipv6 loopback
    ["::ffff:127.0.0.1"], // dotted-quad mapped loopback
    ["::ffff:7f00:1"], // WHATWG URL hex-normalized mapped loopback
    ["[::ffff:7f00:1]"], // bracketed hex-normalized mapped loopback
    ["::ffff:a9fe:a9fe"], // hex-normalized mapped cloud metadata (169.254.169.254)
    ["fd00::1"], // ipv6 unique-local
    ["fe80::1"], // ipv6 link-local
    ["64:ff9b::127.0.0.1"], // NAT64 prefix
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ["93.184.216.34"],
    ["8.8.8.8"],
    ["2606:2800:220:1:248:1893:25c8:1946"],
    ["[2606:2800:220:1:248:1893:25c8:1946]"],
    ["::ffff:93.184.216.34"],
    ["::ffff:5db8:d822"], // 93.184.216.34 in hex-mapped form
  ])("allows public %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("assertPublicHttpsRepoUrl — full guard with injectable resolver (defeats DNS rebinding)", () => {
  it("passes when the host resolves to a public address", async () => {
    const pin = await assertPublicHttpsRepoUrl("https://github.com/x.git", {
      resolve: async () => ["140.82.112.3"],
    });
    // Returns the validated pin so the CALLER pins git's connection to the exact
    // IP the guard checked (no independent re-resolution by git).
    expect(pin).toEqual({ host: "github.com", port: 443, ip: "140.82.112.3" });
  });

  it("returns no pin for an IP-literal host (host IS the checked address)", async () => {
    const pin = await assertPublicHttpsRepoUrl("https://93.184.216.34/x.git", {
      resolve: async () => {
        throw new Error("should not resolve an IP literal");
      },
    });
    expect(pin).toBeUndefined();
  });

  it("returns no pin for a public bracketed IPv6-literal host without invoking DNS", async () => {
    const pin = await assertPublicHttpsRepoUrl(
      "https://[2606:2800:220:1:248:1893:25c8:1946]/x.git",
      {
        resolve: async () => {
          throw new Error("should not resolve an IPv6 literal");
        },
      },
    );
    expect(pin).toBeUndefined();
  });

  it.each([
    ["Allowed host + Redis port 6379", "https://github.com:6379/vellar/wallet.git"],
    ["Allowed host + Postgres port 5432", "https://github.com:5432/vellar/wallet.git"],
    ["Allowed host + Docker port 2375", "https://github.com:2375/vellar/wallet.git"],
    [
      "Public IPv6 literal + Redis port 6379",
      "https://[2606:2800:220:1:248:1893:25c8:1946]:6379/vellar/wallet.git",
    ],
    ["IPv6 loopback [::1]", "https://[::1]/x.git"],
    ["IPv6 loopback [::1] + internal port", "https://[::1]:6379/x.git"],
    ["IPv6-mapped IPv4 loopback [::ffff:127.0.0.1]", "https://[::ffff:127.0.0.1]/x.git"],
    ["IPv6-mapped metadata [::ffff:169.254.169.254]", "https://[::ffff:169.254.169.254]/x.git"],
    ["IPv6 unique-local [fd00::1]", "https://[fd00::1]/x.git"],
    ["IPv6 link-local [fe80::1]", "https://[fe80::1]/x.git"],
  ])("rejects %s (%s) before any DNS resolution", async (_label, url) => {
    const resolve = async () => {
      throw new Error("resolver should not be called for blocked port or IPv6 literal");
    };
    await expect(assertPublicHttpsRepoUrl(url, { resolve })).rejects.toBeInstanceOf(RepoUrlError);
  });

  it("pins the first validated address when several resolve (all validated first)", async () => {
    const pin = await assertPublicHttpsRepoUrl("https://github.com/x.git", {
      resolve: async () => ["140.82.112.3", "140.82.113.4"],
    });
    expect(pin).toEqual({ host: "github.com", port: 443, ip: "140.82.112.3" });
  });

  it("rejects a multi-homed host mixing public + private records (does NOT pin the public leg)", async () => {
    await expect(
      assertPublicHttpsRepoUrl("https://multi.example.com/x.git", {
        resolve: async () => ["140.82.112.3", "10.0.0.5"],
      }),
    ).rejects.toBeInstanceOf(RepoUrlError);
  });

  it("carries a non-standard https port into the pin", async () => {
    const pin = await assertPublicHttpsRepoUrl("https://git.example.com:8443/x.git", {
      resolve: async () => ["203.0.113.9"],
    });
    expect(pin).toEqual({ host: "git.example.com", port: 8443, ip: "203.0.113.9" });
  });

  it("rejects when the host resolves to a private address (rebinding-style)", async () => {
    await expect(
      assertPublicHttpsRepoUrl("https://evil.example.com/x.git", {
        resolve: async () => ["169.254.169.254"],
      }),
    ).rejects.toBeInstanceOf(RepoUrlError);
  });

  it("rejects when ANY resolved address is private (mixed answer)", async () => {
    await expect(
      assertPublicHttpsRepoUrl("https://evil.example.com/x.git", {
        resolve: async () => ["93.184.216.34", "127.0.0.1"],
      }),
    ).rejects.toBeInstanceOf(RepoUrlError);
  });

  it("rejects when the host does not resolve at all", async () => {
    await expect(
      assertPublicHttpsRepoUrl("https://nope.example.com/x.git", {
        resolve: async () => [],
      }),
    ).rejects.toBeInstanceOf(RepoUrlError);
  });

  it("rejects a non-https URL before any resolution", async () => {
    const resolve = async () => {
      throw new Error("resolver should not be called");
    };
    await expect(
      assertPublicHttpsRepoUrl("http://127.0.0.1/x", { resolve }),
    ).rejects.toBeInstanceOf(RepoUrlError);
  });
});

describe("gitConnectionPinArgs — pin git's connection + forbid redirects", () => {
  it("pins host:port:ip and forbids redirects when a pin is present", () => {
    const args = gitConnectionPinArgs({ host: "github.com", port: 443, ip: "140.82.112.3" });
    expect(args).toEqual([
      "-c",
      "http.followRedirects=false",
      "-c",
      "http.curloptResolve=github.com:443:140.82.112.3",
    ]);
  });

  it("still forbids redirects with no pin (IP-literal host)", () => {
    expect(gitConnectionPinArgs(undefined)).toEqual(["-c", "http.followRedirects=false"]);
  });
});
