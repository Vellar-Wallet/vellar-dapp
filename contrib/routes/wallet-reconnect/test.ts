/**
 * Test suite for wallet reconnection
 * Validates key matching and error handling
 */

import { reconnectWallet, getAllRegisteredKeys, isKeyRegistered } from "./reconnector";
import { knownKeyIds, unknownKeyId, walletRegistry } from "./sample-registry";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

function runTests(): void {
  console.log("🧪 Running wallet reconnect tests...\n");

  // Test 1: Reconnect with known key ID
  console.log("Test 1: Known Key ID Reconnection");
  const knownKey = knownKeyIds[0];
  const knownResult = reconnectWallet(knownKey);
  assert(knownResult.success === true, "Should successfully reconnect with known key");
  assert("walletId" in knownResult && knownResult.walletId !== "", "Should return a walletId");
  assert(
    "keyId" in knownResult && knownResult.keyId === knownKey,
    "Should return the matching keyId",
  );
  console.log();

  // Test 2: Verify wallet ID matches registry
  console.log("Test 2: Correct Wallet ID Returned");
  const registryEntry = walletRegistry.find((e) => e.keyId === knownKey);
  assert(
    "walletId" in knownResult && registryEntry && knownResult.walletId === registryEntry.walletId,
    "Returned walletId should match registry",
  );
  console.log();

  // Test 3: Unknown key returns 404 error
  console.log("Test 3: Unknown Key ID (404 Error)");
  const unknownResult = reconnectWallet(unknownKeyId);
  assert(unknownResult.success === false, "Should fail with unknown key");
  assert(
    !("walletId" in unknownResult) && unknownResult.error === "NOT_FOUND",
    "Should return NOT_FOUND error",
  );
  assert("message" in unknownResult && unknownResult.message !== "", "Should return error message");
  console.log();

  // Test 4: Empty key ID returns error
  console.log("Test 4: Empty Key ID Handling");
  const emptyResult = reconnectWallet("");
  assert(emptyResult.success === false, "Empty key should return error");
  assert(emptyResult.error === "NOT_FOUND", "Empty key should return NOT_FOUND error");
  console.log();

  // Test 5: Whitespace-only key ID returns error
  console.log("Test 5: Whitespace Key ID Handling");
  const whitespaceResult = reconnectWallet("   ");
  assert(whitespaceResult.success === false, "Whitespace key should return error");
  console.log();

  // Test 6: All sample keys are accessible
  console.log("Test 6: All Sample Keys Are Accessible");
  knownKeyIds.forEach((keyId, index) => {
    const result = reconnectWallet(keyId);
    assert(result.success === true, `Sample key ${index + 1} (${keyId}) should be accessible`);
  });
  console.log();

  // Test 7: Consistent results across multiple calls
  console.log("Test 7: Consistent Results");
  const firstCall = reconnectWallet(knownKey);
  const secondCall = reconnectWallet(knownKey);
  assert(
    "walletId" in firstCall &&
      "walletId" in secondCall &&
      firstCall.walletId === secondCall.walletId,
    "Same key should return same walletId",
  );
  console.log();

  // Test 8: getAllRegisteredKeys returns all keys
  console.log("Test 8: Get All Registered Keys");
  const allKeys = getAllRegisteredKeys();
  assert(allKeys.length === knownKeyIds.length, "Should return all registered keys");
  assert(
    allKeys.every((key) => knownKeyIds.includes(key)),
    "Should only return known keys",
  );
  console.log();

  // Test 9: isKeyRegistered works correctly
  console.log("Test 9: Key Registration Check");
  assert(isKeyRegistered(knownKey), "Known key should be registered");
  assert(!isKeyRegistered(unknownKeyId), "Unknown key should not be registered");
  console.log();

  // Test 10: Different keys return different wallets
  console.log("Test 10: Different Keys Map to Different Wallets");
  if (knownKeyIds.length >= 2) {
    const result1 = reconnectWallet(knownKeyIds[0]);
    const result2 = reconnectWallet(knownKeyIds[1]);
    assert(
      "walletId" in result1 && "walletId" in result2 && result1.walletId !== result2.walletId,
      "Different keys should map to different wallets",
    );
  }
  console.log();

  console.log("✅ All tests passed!\n");
  console.log("Reconnection Summary:");
  console.log(`  Registered Keys: ${knownKeyIds.length}`);
  knownKeyIds.forEach((keyId) => {
    const result = reconnectWallet(keyId);
    if (result.success) {
      console.log(`    • ${keyId} → ${result.walletId}`);
    }
  });
  console.log();
  console.log("Error Handling:");
  console.log(`  Unknown Key "${unknownKeyId}": ${unknownResult.message}`);
}

runTests();
