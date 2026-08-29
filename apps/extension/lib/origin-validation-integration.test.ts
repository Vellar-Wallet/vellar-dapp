import { describe, expect, it } from "vitest";
import { normalizeOrigin as permissionServiceNormalizeOrigin } from "@vellar/permission-service";
import { normalizeOrigin as providerSdkNormalizeOrigin } from "@vellar/provider-sdk";

/**
 * Integration test: verifies that the re-export facade in permission-service
 * produces identical validation results as importing directly from provider-sdk.
 * This confirms the refactor (#348) correctly consolidates origin validation
 * through permission-service without behavioral change.
 *
 * Both call paths should be identical because permission-service simply
 * re-exports from provider-sdk; this test confirms the re-export is correct
 * and both imports resolve to the same underlying implementation.
 */
describe("Origin Validation Facade Integration (refactor #348)", () => {
  // Comprehensive edge-case test vectors covering all scenarios in
  // packages/provider-sdk/src/permissions.test.ts
  const testVectors = [
    // Valid origins
    ["https://app.example.com", "https://app.example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://app.example.com:8443", "https://app.example.com:8443"],

    // Trailing-dot FQDN normalization (L5: collapse single trailing dot)
    ["https://app.example.com.", "https://app.example.com"],
    ["https://app.example.com.:8443", "https://app.example.com:8443"],
    ["http://localhost.", "http://localhost"],

    // Invalid: path/query attached
    ["https://app.example.com/evil", undefined],
    ["https://app.example.com?x=1", undefined],
    ["https://app.example.com/", undefined],

    // Invalid: non-URLs
    ["app.example.com", undefined],
    ["", undefined],

    // Invalid: dangerous schemes
    ["file:///etc/passwd", undefined],
    ["chrome-extension://abcdef", undefined],
    ["javascript:alert(1)", undefined],

    // Invalid: doubled trailing dots (malformed; stays distinct)
    ["https://app.example.com..", "https://app.example.com."],
  ] as const;

  it.each(testVectors)(
    "both call paths normalize %s identically",
    (input, expectedNormalized) => {
      // Call path 1: via permission-service facade
      const fromPermissionService = permissionServiceNormalizeOrigin(input);

      // Call path 2: direct from provider-sdk
      const fromProviderSdk = providerSdkNormalizeOrigin(input);

      // Both must be identical
      expect(fromPermissionService).toBe(fromProviderSdk);

      // Both must match the expected result
      expect(fromPermissionService).toBe(expectedNormalized);
    },
  );

  it("both call paths produce the same result for the dotted/dotless equivalence", () => {
    const dotted = "https://app.example.com.";
    const dotless = "https://app.example.com";

    const dottedViaPermissionService = permissionServiceNormalizeOrigin(dotted);
    const dotlessViaPermissionService = permissionServiceNormalizeOrigin(dotless);
    const dottedViaProviderSdk = providerSdkNormalizeOrigin(dotted);
    const dotlessViaProviderSdk = providerSdkNormalizeOrigin(dotless);

    // All four should be identical
    expect(dottedViaPermissionService).toBe(dotlessViaPermissionService);
    expect(dottedViaProviderSdk).toBe(dotlessViaProviderSdk);
    expect(dottedViaPermissionService).toBe(dottedViaProviderSdk);
  });
});
