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

// RA-7: every IPv6 spelling of an IPv4 address must be judged by that IPv4
// address, not by a string-prefix match on the IPv6 text. The encodings below
// are generated from the v4 octets so each target is covered in every form.
function hexGroups(v4: string): [string, string] {
  const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

function pad4(group: string): string {
  return group.padStart(4, "0");
}

/** Every IPv6 spelling that embeds `v4` and is judged by it, labelled by encoding. */
function embeddedEncodings(v4: string): Array<[string, string]> {
  const [hi, lo] = hexGroups(v4);
  return [
    ["mapped dotted", `::ffff:${v4}`],
    ["mapped hex", `::ffff:${hi}:${lo}`],
    ["mapped hex upper", `::FFFF:${hi.toUpperCase()}:${lo.toUpperCase()}`],
    ["mapped expanded", `0:0:0:0:0:ffff:${hi}:${lo}`],
    ["mapped expanded dotted tail", `0:0:0:0:0:ffff:${v4}`],
    ["mapped zero-padded", `0000:0000:0000:0000:0000:ffff:${pad4(hi)}:${pad4(lo)}`],
    ["mapped compressed mid", `0:0::ffff:${hi}:${lo}`],
    ["NAT64 dotted", `64:ff9b::${v4}`],
    ["NAT64 hex", `64:ff9b::${hi}:${lo}`],
    ["NAT64 expanded", `64:ff9b:0:0:0:0:${hi}:${lo}`],
    ["NAT64 zero-padded", `0064:ff9b:0000:0000:0000:0000:${pad4(hi)}:${pad4(lo)}`],
    ["IPv4-translated (SIIT) dotted", `::ffff:0:${v4}`],
    ["IPv4-translated (SIIT) hex", `::ffff:0:${hi}:${lo}`],
    ["6to4", `2002:${hi}:${lo}::`],
    ["6to4 with host bits", `2002:${hi}:${lo}:1:2:3:4:5`],
  ];
}

describe("isBlockedAddress — IPv6 encodings of blocked IPv4 addresses (RA-7)", () => {
  const blockedV4 = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "0.0.0.0",
  ];

  for (const v4 of blockedV4) {
    it.each(embeddedEncodings(v4))(`blocks ${v4} as %s (%s)`, (_label, ip) => {
      expect(isBlockedAddress(ip)).toBe(true);
    });
  }

  it.each([
    ["::1"],
    ["0:0:0:0:0:0:0:1"],
    ["0000:0000:0000:0000:0000:0000:0000:0001"],
    ["::0001"],
    ["0::1"],
    ["::"],
    ["0:0:0:0:0:0:0:0"],
    ["::1%lo0"], // a zone id must not defeat the check
    ["fe80::1%eth0"],
    ["::ffff:7f00:1%lo0"],
  ])("blocks every spelling of loopback / unspecified: %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ["fe80::1"],
    ["fe90::1"], // fe80::/10 is wider than the fe80 text prefix
    ["feaf::1"],
    ["febf:ffff::1"],
    ["fec0::1"], // deprecated site-local
    ["fc00::1"],
    ["fdff::1"],
    ["ff02::1"],
    ["FE80::1"],
    ["64:ff9b:1::1"], // local-use NAT64 (RFC 8215) can reach anything the NAT64 box can
    ["2001::1"], // Teredo: embeds an obfuscated v4, never a legitimate clone target
    ["2001:db8::1"], // documentation range is never routable
    ["100::1"], // discard-only prefix
  ])("blocks non-public IPv6 range: %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([["8.8.8.8"], ["93.184.216.34"], ["1.1.1.1"]])(
    "still allows a public %s in every embedded encoding",
    (v4) => {
      for (const [label, ip] of embeddedEncodings(v4)) {
        expect(isBlockedAddress(ip), `${label}: ${ip}`).toBe(false);
      }
    },
  );

  // ::/96 (IPv4-compatible) is deprecated by RFC 4291 and has no legitimate use
  // as a remote clone target, so the whole range is blocked rather than judged
  // on its embedded address.
  it.each([
    ["::127.0.0.1"],
    ["::7f00:1"],
    ["::10.0.0.1"],
    ["::8.8.8.8"],
    ["::808:808"],
    ["0:0:0:0:0:0:808:808"],
    ["::5"],
  ])("blocks the deprecated IPv4-compatible range ::/96: %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ["2606:4700:4700::1111"],
    ["2a00:1450:4001:81b::200e"],
    ["2001:4860:4860::8888"], // 2001::/32 is Teredo ONLY for 2001:0000::, not all of 2001::/16
    ["64:ff9a::1"], // one nibble off the NAT64 prefix is just a public address
  ])("allows ordinary public IPv6: %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it.each([["not-an-ip"], [""], ["::ffff:999.1.1.1"], ["1.2.3"], ["[::1]"], ["127.1"], ["0x7f.1"]])(
    "treats a non-IP string as blocked (caller resolves hostnames): %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(true);
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

  it.each([
    ["::ffff:7f00:1"],
    ["::ffff:a9fe:a9fe"],
    ["64:ff9b::a9fe:a9fe"],
    ["2002:7f00:1::"],
    ["::1"],
  ])("rejects a hostname whose resolver answers with %s (RA-7)", async (answer) => {
    await expect(
      assertPublicHttpsRepoUrl("https://rebind.example.com/x.git", {
        resolve: async () => [answer],
      }),
    ).rejects.toThrow(RepoUrlError);
  });

  it("rejects a mixed public + hex-mapped-private answer set (rebinding leg)", async () => {
    await expect(
      assertPublicHttpsRepoUrl("https://rebind.example.com/x.git", {
        resolve: async () => ["140.82.112.3", "::ffff:a00:1"],
      }),
    ).rejects.toThrow(RepoUrlError);
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
