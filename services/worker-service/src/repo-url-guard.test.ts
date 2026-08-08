import { describe, expect, it } from "vitest";
import {
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
});

describe("isBlockedAddress — private / loopback / link-local ranges", () => {
  it.each([
    ["127.0.0.1"],
    ["0.0.0.0"],
    ["10.1.2.3"],
    ["172.16.5.4"],
    ["192.168.1.1"],
    ["169.254.169.254"], // cloud metadata
    ["::1"], // ipv6 loopback
    ["fd00::1"], // ipv6 unique-local
    ["fe80::1"], // ipv6 link-local
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([["93.184.216.34"], ["8.8.8.8"], ["2606:2800:220:1:248:1893:25c8:1946"]])(
    "allows public %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
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

  it("pins the first validated address when several resolve", async () => {
    const pin = await assertPublicHttpsRepoUrl("https://github.com/x.git", {
      resolve: async () => ["140.82.112.3", "140.82.113.4"],
    });
    expect(pin).toEqual({ host: "github.com", port: 443, ip: "140.82.112.3" });
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
