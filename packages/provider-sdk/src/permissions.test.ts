import { describe, expect, it } from "vitest";
import { hasCapability, normalizeOrigin, type PermissionGrant } from "./permissions";

describe("normalizeOrigin", () => {
  it.each([
    ["https://app.example.com", "https://app.example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://app.example.com:8443", "https://app.example.com:8443"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it.each([
    ["path attached", "https://app.example.com/evil"],
    ["query attached", "https://app.example.com?x=1"],
    ["trailing slash", "https://app.example.com/"],
    ["not a url", "app.example.com"],
    ["file scheme", "file:///etc/passwd"],
    ["chrome-extension scheme", "chrome-extension://abcdef"],
    ["javascript scheme", "javascript:alert(1)"],
    ["empty", ""],
  ])("rejects %s", (_label, input) => {
    expect(normalizeOrigin(input)).toBeUndefined();
  });

  // L5: a trailing-dot FQDN ("app.example.com.") is the SAME principal as the
  // dotless form — collapse the single trailing dot so they don't become two
  // distinct grant keys.
  it.each([
    ["trailing dot host", "https://app.example.com.", "https://app.example.com"],
    [
      "trailing dot with explicit port",
      "https://app.example.com.:8443",
      "https://app.example.com:8443",
    ],
    ["trailing dot on localhost", "http://localhost.", "http://localhost"],
  ])("normalizes %s to the dotless origin", (_label, input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it("collapses only a SINGLE trailing dot (a doubled dot stays distinct)", () => {
    // ".." is malformed; we strip one dot, leaving it distinct from the clean
    // form — we don't try to canonicalize arbitrary garbage.
    expect(normalizeOrigin("https://app.example.com..")).toBe("https://app.example.com.");
  });

  it("the dotted and dotless forms map to the SAME normalized origin", () => {
    expect(normalizeOrigin("https://app.example.com.")).toBe(
      normalizeOrigin("https://app.example.com"),
    );
  });
});

describe("hasCapability", () => {
  const grant: PermissionGrant = {
    origin: "https://dapp.example",
    accountId: "CABC",
    network: "testnet",
    capabilities: ["connect", "view_address"],
    grantedAt: "2026-07-16T10:00:00.000Z",
  };

  it("matches origin, network, and capability together", () => {
    expect(hasCapability([grant], "https://dapp.example", "testnet", "view_address")).toBe(true);
  });

  it.each([
    ["different origin", "https://evil.example", "testnet", "view_address"],
    ["different network", "https://dapp.example", "mainnet", "view_address"],
    ["ungranted capability", "https://dapp.example", "testnet", "sign"],
  ] as const)("denies on %s", (_label, origin, network, capability) => {
    expect(hasCapability([grant], origin, network, capability)).toBe(false);
  });

  it("denies with no grants at all", () => {
    expect(hasCapability([], "https://dapp.example", "testnet", "connect")).toBe(false);
  });
});

describe("hasCapability — Origin Matcher Security Tests (Issue #322)", () => {
  /**
   * Security-critical tests for origin-matching logic. Origins are derived from
   * the trusted browser context (content script sender) and used to enforce
   * permission boundaries — subtle origin-matching bugs can allow untrusted
   * sites to inherit permissions granted to different origins (a real security
   * vulnerability in wallet/extension software).
   */

  describe("Exact Origin Match", () => {
    it("matches when grant origin and incoming origin are identical (https)", () => {
      const grant: PermissionGrant = {
        origin: "https://app.example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      expect(
        hasCapability([grant], "https://app.example.com", "testnet", "sign")
      ).toBe(true);
    });

    it("matches when grant origin and incoming origin are identical (http)", () => {
      const grant: PermissionGrant = {
        origin: "http://localhost:3000",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      expect(
        hasCapability([grant], "http://localhost:3000", "testnet", "sign")
      ).toBe(true);
    });

    it("matches when grant origin and incoming origin are identical (https with explicit non-default port)", () => {
      const grant: PermissionGrant = {
        origin: "https://app.example.com:8443",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      expect(
        hasCapability([grant], "https://app.example.com:8443", "testnet", "sign")
      ).toBe(true);
    });
  });

  describe("Subdomain Mismatch Rejection (Security: subdomains are distinct origins)", () => {
    /**
     * Per the Web Origin specification (RFC 6454), a subdomain is a distinct
     * origin from its parent domain. For example, https://sub.example.com and
     * https://example.com are NOT equivalent; they must not be treated as
     * equivalent for permission granting.
     *
     * This is a real security boundary: a permission granted to one subdomain
     * must never be inherited by a different subdomain or the parent domain.
     * Failure to enforce this can allow an attacker to set up a lookalike
     * subdomain and inherit permissions intended for a different service.
     */

    it("denies when grant is for parent domain but request is from subdomain", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Subdomain MUST NOT inherit permission from parent domain
      expect(
        hasCapability([grant], "https://sub.example.com", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when grant is for subdomain but request is from parent domain", () => {
      const grant: PermissionGrant = {
        origin: "https://sub.example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Parent domain MUST NOT inherit permission from subdomain
      expect(
        hasCapability([grant], "https://example.com", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when grant is for one subdomain but request is from a different subdomain", () => {
      const grant: PermissionGrant = {
        origin: "https://app1.example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Different subdomains are distinct origins; one must not inherit from the other
      expect(
        hasCapability([grant], "https://app2.example.com", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when grant is for multiple-level subdomain but request is from parent", () => {
      const grant: PermissionGrant = {
        origin: "https://api.v1.example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Multi-level subdomains are distinct from all parent levels
      expect(
        hasCapability([grant], "https://v1.example.com", "testnet", "sign")
      ).toBe(false);
    });
  });

  describe("Scheme Mismatch Rejection (Security: http is distinct from https)", () => {
    /**
     * Scheme is a component of the Web Origin (RFC 6454). An origin with
     * https:// scheme is NOT equivalent to one with http:// scheme, even if
     * the host and port are identical.
     *
     * This boundary is critical: https:// origins have encrypted transport and
     * should not be treated as equivalent to unencrypted http:// origins. A
     * permission granted to https://example.com must never be inherited by
     * http://example.com, as this could allow an attacker on the same network
     * to intercept and exploit the permission via an unencrypted connection.
     */

    it("denies when grant is https but request is http (same host)", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // http MUST NOT inherit permission from https
      expect(
        hasCapability([grant], "http://example.com", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when grant is http but request is https (same host)", () => {
      const grant: PermissionGrant = {
        origin: "http://localhost:3000",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // https MUST NOT inherit permission from http (even localhost)
      expect(
        hasCapability([grant], "https://localhost:3000", "testnet", "sign")
      ).toBe(false);
    });
  });

  describe("Port Mismatch Rejection (Security: ports are part of the origin)", () => {
    /**
     * Port is a component of the Web Origin (RFC 6454). An explicit port in the
     * origin string must match exactly. Origins with and without explicit ports
     * (where one uses the default port for the scheme, the other uses implicit)
     * are distinct string-wise.
     *
     * Note: This implementation uses exact string comparison, so
     * https://example.com (implicit port 443) is NOT equivalent to
     * https://example.com:443 (explicit port 443) at the string level.
     * This is correct behavior for permission matching: the stored grant must
     * match exactly.
     */

    it("denies when grant is for explicit port but request has different explicit port", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com:8443",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Different explicit ports are distinct origins
      expect(
        hasCapability([grant], "https://example.com:9443", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when grant has implicit port (no port in origin string) but request has explicit port", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Implicit (default) port vs explicit port are distinct strings
      expect(
        hasCapability([grant], "https://example.com:443", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when grant has explicit port but request has implicit port", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com:443",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Explicit port vs implicit (default) port are distinct strings
      expect(
        hasCapability([grant], "https://example.com", "testnet", "sign")
      ).toBe(false);
    });
  });

  describe("Malformed/Invalid Origin Input Handling (Fail-Closed Security)", () => {
    /**
     * The origin-matching function must reject (return false) for malformed or
     * invalid input, never accidentally treat malformed input as a match. This
     * is a fail-closed security posture: when in doubt (malformed input), deny.
     *
     * In this codebase, grants are stored with normalized origins (via
     * normalizeOrigin()), so the grant origin should always be well-formed.
     * However, incoming requests must also pass normalized origins — if for
     * some reason a malformed origin reaches hasCapability(), it must not
     * accidentally match.
     *
     * Since the matcher uses exact string equality, a malformed incoming origin
     * will not match any well-formed grant (correct fail-closed behavior).
     * However, we test this explicitly to document the contract.
     */

    it("denies when incoming origin is empty string", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Empty origin must not match
      expect(
        hasCapability([grant], "", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when incoming origin lacks scheme", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Scheme-less origin is malformed and must not match
      expect(
        hasCapability([grant], "example.com", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when incoming origin has path component", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Origin with path is malformed (normalizeOrigin rejects these)
      expect(
        hasCapability([grant], "https://example.com/app", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when incoming origin has query component", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Origin with query is malformed (normalizeOrigin rejects these)
      expect(
        hasCapability([grant], "https://example.com?x=1", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when incoming origin has unusual/invalid characters", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // Unusual characters in origin are malformed
      expect(
        hasCapability([grant], "https://exam ple.com", "testnet", "sign")
      ).toBe(false);
    });

    it("denies when incoming origin is a non-http scheme (fail-closed for unknown schemes)", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com",
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // chrome-extension:// is rejected by normalizeOrigin, so it will never match
      expect(
        hasCapability([grant], "chrome-extension://abcdef", "testnet", "sign")
      ).toBe(false);
    });
  });

  describe("Case Sensitivity (Origins are case-insensitive per URL standard)", () => {
    /**
     * Per RFC 3986 and the URL Standard, scheme and hostname are case-insensitive
     * components of the URL/origin. The implementation uses URL.origin, which
     * normalizes these to lowercase, so:
     *   new URL("HTTPS://EXAMPLE.COM").origin === "https://example.com"
     *
     * This test verifies that origins are properly case-normalized, so that
     * grants stored with normalized origins and checked against normalized
     * incoming origins will correctly match despite case differences in input.
     */

    it("should normalize uppercase scheme and domain when stored via normalizeOrigin()", () => {
      // normalizeOrigin() uses URL parsing, which normalizes to lowercase
      expect(normalizeOrigin("HTTPS://EXAMPLE.COM")).toBe("https://example.com");
    });

    it("should normalize mixed-case scheme and domain when stored via normalizeOrigin()", () => {
      expect(normalizeOrigin("HtTpS://ExAmple.CoM")).toBe("https://example.com");
    });

    it("should match when both grant and incoming origin are normalized (case-insensitive matching works correctly)", () => {
      const grant: PermissionGrant = {
        origin: normalizeOrigin("HTTPS://EXAMPLE.COM") || "", // Normalized to lowercase
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      const incomingOrigin = normalizeOrigin("https://example.com") || ""; // Also normalized
      expect(hasCapability([grant], incomingOrigin, "testnet", "sign")).toBe(true);
    });

    it("should NOT match if incoming origin is passed unnormalized (case-sensitive string comparison at matcher level)", () => {
      const grant: PermissionGrant = {
        origin: "https://example.com", // Stored normalized (lowercase)
        accountId: "CABC",
        network: "testnet",
        capabilities: ["sign"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      };

      // If malformed/unnormalized uppercase origin is passed directly (shouldn't happen in normal flow),
      // exact string match fails. This documents the implementation contract: hasCapability expects
      // both grant.origin and the incoming origin to already be normalized.
      expect(hasCapability([grant], "HTTPS://EXAMPLE.COM", "testnet", "sign")).toBe(false);
    });
  });

  describe("Multiple Grants: Matching Any One", () => {
    /**
     * hasCapability iterates over an array of grants and returns true if ANY
     * grant matches all criteria (origin, network, capability). This test
     * verifies that the matcher correctly stops at the first match and allows
     * the permission when one of several grants matches.
     */

    it("matches when one of multiple grants has the matching origin, network, and capability", () => {
      const grants: PermissionGrant[] = [
        {
          origin: "https://app1.example.com",
          accountId: "CABC",
          network: "testnet",
          capabilities: ["view_address"],
          grantedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          origin: "https://app2.example.com",
          accountId: "CABC",
          network: "testnet",
          capabilities: ["sign"],
          grantedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          origin: "https://app3.example.com",
          accountId: "CABC",
          network: "mainnet",
          capabilities: ["sign"],
          grantedAt: "2026-01-01T00:00:00.000Z",
        },
      ];

      // Only the second grant matches
      expect(hasCapability(grants, "https://app2.example.com", "testnet", "sign")).toBe(true);
    });

    it("denies when no grant matches the origin (even if network and capability would match other grants)", () => {
      const grants: PermissionGrant[] = [
        {
          origin: "https://app1.example.com",
          accountId: "CABC",
          network: "testnet",
          capabilities: ["sign"],
          grantedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          origin: "https://app2.example.com",
          accountId: "CABC",
          network: "testnet",
          capabilities: ["sign"],
          grantedAt: "2026-01-01T00:00:00.000Z",
        },
      ];

      // Request from ungranted origin is denied, even though other grants have sign capability on testnet
      expect(hasCapability(grants, "https://evil.example.com", "testnet", "sign")).toBe(false);
    });
  });
});
