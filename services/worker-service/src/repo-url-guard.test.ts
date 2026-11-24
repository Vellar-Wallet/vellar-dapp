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

describe("userinfo / fragment parser-differential bypasses (#837)", () => {
  // The guard validates the WHATWG-parsed host, but git/libcurl clone the RAW
  // string. Each input below is one where a naive string check, WHATWG, and
  // curl can disagree about which part is the real host.
  const neverResolve = async (): Promise<string[]> => {
    throw new Error("resolver must not be reached for a rejected URL");
  };

  it("happy path: a plain public https repo URL (with query) still passes and pins", async () => {
    expect(parseHttpsRepoUrl("https://github.com/vellar/wallet.git?ref=main").hostname).toBe(
      "github.com",
    );
    await expect(
      assertPublicHttpsRepoUrl("https://github.com/vellar/wallet.git", {
        resolve: async () => ["140.82.112.3"],
      }),
    ).resolves.toEqual({ host: "github.com", port: 443, ip: "140.82.112.3" });
  });

  it("happy path: an `@` in the PATH (not the authority) is not userinfo", () => {
    expect(parseHttpsRepoUrl("https://gitlab.com/@scope/repo.git").hostname).toBe("gitlab.com");
  });

  it.each([
    ["allowed-host@internal-host", "https://github.com@169.254.169.254/latest/meta-data"],
    ["user-only userinfo", "https://github.com@internal.corp/repo.git"],
    ["user:password userinfo", "https://user:pass@internal.corp/repo.git"],
    ["empty userinfo (`@` only)", "https://@internal.corp/repo.git"],
    ["empty user + empty password (`:@`)", "https://:@internal.corp/repo.git"],
    ["multiple `@` in authority", "https://a@b@internal.corp/repo.git"],
    ["userinfo shaped like host:port", "https://github.com:443@10.0.0.5:8443/repo.git"],
  ])("rejects userinfo in the authority: %s", async (_label, url) => {
    expect(() => parseHttpsRepoUrl(url)).toThrow(RepoUrlError);
    expect(() => parseHttpsRepoUrl(url)).toThrow(/userinfo/);
    await expect(assertPublicHttpsRepoUrl(url, { resolve: neverResolve })).rejects.toBeInstanceOf(
      RepoUrlError,
    );
  });

  it("documents why the empty-userinfo case needs the raw check: WHATWG reports no credentials", () => {
    const parsed = new URL("https://@internal.corp/repo.git");
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
    expect(() => parseHttpsRepoUrl("https://@internal.corp/repo.git")).toThrow(RepoUrlError);
  });

  it.each([
    ["fragment hiding the real host", "https://169.254.169.254#@github.com/vellar/wallet.git"],
    ["fragment after a normal path", "https://github.com/vellar/wallet.git#@internal.corp"],
    ["empty fragment", "https://github.com/vellar/wallet.git#"],
  ])("rejects a fragment: %s", async (_label, url) => {
    expect(() => parseHttpsRepoUrl(url)).toThrow(/fragment/);
    await expect(assertPublicHttpsRepoUrl(url, { resolve: neverResolve })).rejects.toBeInstanceOf(
      RepoUrlError,
    );
  });

  it("rejects a backslash: WHATWG reads host `github.com`, curl reads host `internal.corp`", async () => {
    const url = "https://github.com\\@internal.corp/repo.git";
    // Proof of the disagreement: WHATWG would have accepted github.com.
    expect(new URL(url).hostname).toBe("github.com");
    expect(() => parseHttpsRepoUrl(url)).toThrow(/backslash/);
    await expect(assertPublicHttpsRepoUrl(url, { resolve: neverResolve })).rejects.toBeInstanceOf(
      RepoUrlError,
    );
  });

  it.each([
    ["tab inside the authority", "https://github.com\t@internal.corp/repo.git"],
    ["newline inside the authority", "https://github.com\n@internal.corp/repo.git"],
    ["leading space", " https://github.com/vellar/wallet.git"],
    ["trailing NUL", "https://github.com/vellar/wallet.git\u0000"],
  ])("rejects whitespace/control characters WHATWG would silently strip: %s", (_label, url) => {
    expect(() => parseHttpsRepoUrl(url)).toThrow(/whitespace or control/);
  });

  it.each([
    ["missing slashes", "https:github.com/vellar/wallet.git"],
    ["single slash", "https:/github.com/vellar/wallet.git"],
    ["triple slash", "https:///github.com/vellar/wallet.git"],
  ])("rejects scheme shapes WHATWG repairs but git does not: %s", (_label, url) => {
    // WHATWG normalizes every one of these to host github.com…
    expect(new URL(url).hostname).toBe("github.com");
    // …but the raw string git receives is not that URL.
    expect(() => parseHttpsRepoUrl(url)).toThrow(/absolute https:\/\//);
  });

  it("keeps the port-based coverage independent: a userinfo+port combo is still refused before DNS", async () => {
    let resolved = false;
    await expect(
      assertPublicHttpsRepoUrl("https://github.com:443@127.0.0.1:22/x", {
        resolve: async () => {
          resolved = true;
          return ["140.82.112.3"];
        },
      }),
    ).rejects.toBeInstanceOf(RepoUrlError);
    expect(resolved).toBe(false);
  });
});
