/**
 * Test suite for wallet creation handshake
 * Validates the two-step register and confirm flow
 */

import { registerWallet, confirmWallet, getWalletState, clearWalletStorage } from "./handshake";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

function runTests(): void {
  console.log("🧪 Running wallet creation handshake tests...\n");

  // Test 1: Register endpoint returns required fields
  console.log("Test 1: Register Endpoint");
  const registration = registerWallet();
  assert(registration.walletId !== "", "Register should return a walletId");
  assert(registration.challenge !== "", "Register should return a challenge");
  assert(registration.status === "pending", "Register should return status=pending");
  console.log();

  // Test 2: Confirm endpoint succeeds with valid walletId
  console.log("Test 2: Confirm Endpoint");
  const confirmation = confirmWallet(registration.walletId);
  assert(
    confirmation.walletId === registration.walletId,
    "Confirm should return the same walletId",
  );
  assert(confirmation.status === "created", "Confirm should return status=created");
  assert(confirmation.message !== "", "Confirm should return a success message");
  console.log();

  // Test 3: Full handshake sequence
  console.log("Test 3: Complete Handshake Flow");
  const reg2 = registerWallet();
  assert(
    reg2.walletId !== registration.walletId,
    "Each register call should produce a unique walletId",
  );
  const conf2 = confirmWallet(reg2.walletId);
  assert(conf2.status === "created", "Second handshake should also succeed");
  console.log();

  // Test 4: Cannot confirm already confirmed wallet
  console.log("Test 4: Cannot Double-Confirm");
  const doubleConfirm = confirmWallet(registration.walletId);
  assert(
    doubleConfirm.status === "error",
    "Confirming an already confirmed wallet should return error",
  );
  assert(
    doubleConfirm.message === "Wallet already created",
    'Should return "already created" error message',
  );
  console.log();

  // Test 5: Confirm fails with invalid walletId
  console.log("Test 5: Invalid Wallet ID");
  const invalidConfirm = confirmWallet("invalid_wallet_id");
  assert(invalidConfirm.status === "error", "Confirming invalid wallet should return error");
  assert(invalidConfirm.message !== "", "Error confirmation should have message");
  console.log();

  // Test 6: Wallet state tracking
  console.log("Test 6: Wallet State Tracking");
  clearWalletStorage();
  const reg3 = registerWallet();
  const pendingState = getWalletState(reg3.walletId);
  assert(pendingState !== undefined, "Should be able to retrieve pending wallet state");
  assert(pendingState?.status === "pending", "Pending wallet should have status=pending");
  assert(
    pendingState?.challenge === reg3.challenge,
    "Retrieved state should have matching challenge",
  );

  confirmWallet(reg3.walletId);
  const createdState = getWalletState(reg3.walletId);
  assert(createdState?.status === "created", "Confirmed wallet should have status=created");
  console.log();

  // Test 7: Multiple concurrent registrations
  console.log("Test 7: Multiple Concurrent Registrations");
  clearWalletStorage();
  const regs = [registerWallet(), registerWallet(), registerWallet()];
  const ids = new Set(regs.map((r) => r.walletId));
  assert(ids.size === 3, "Each registration should produce a unique walletId");

  const confs = regs.map((r) => confirmWallet(r.walletId));
  const allCreated = confs.every((c) => c.status === "created");
  assert(allCreated, "All concurrent registrations should confirm successfully");
  console.log();

  // Test 8: Challenge strings are unique
  console.log("Test 8: Unique Challenge Strings");
  clearWalletStorage();
  const reg4 = registerWallet();
  const reg5 = registerWallet();
  assert(reg4.challenge !== reg5.challenge, "Each registration should produce a unique challenge");
  console.log();

  console.log("✅ All tests passed!\n");
  console.log("Handshake Flow Summary:");
  console.log("  1. registerWallet()");
  console.log("     ✓ Returns pending walletId and challenge");
  console.log("  2. confirmWallet(walletId)");
  console.log("     ✓ Confirms wallet creation");
  console.log("     ✓ Returns status=created");
  console.log("     ✓ Cannot be called twice on same wallet");
}

runTests();
