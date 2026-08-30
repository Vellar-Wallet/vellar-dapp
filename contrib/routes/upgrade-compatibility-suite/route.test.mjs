import assert from "node:assert/strict";
import {
  handleCurrentVersion,
  handleCheckUpgrade,
  DEPLOYED_CONTRACTS,
  WASM_CATALOG,
} from "./route.mjs";

// --- current-version reports the deployed hash and its metadata ---
{
  const result = handleCurrentVersion({ body: { contractId: "escrow-main" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.hash, DEPLOYED_CONTRACTS["escrow-main"].hash);
  assert.equal(result.body.storageVersion, WASM_CATALOG.wasm_escrow_v1.storageVersion);
  assert.ok(Array.isArray(result.body.functions));
}

{
  const missing = handleCurrentVersion({ body: { contractId: "does-not-exist" } });
  assert.equal(missing.status, 404);
}

{
  assert.equal(handleCurrentVersion({ body: {} }).status, 400);
}

// --- check-upgrade: a compatible pair reports no concerns ---
{
  const compatible = handleCheckUpgrade({
    body: { contractId: "escrow-main", proposedHash: "wasm_escrow_v2_compatible" },
  });
  assert.equal(compatible.status, 200);
  assert.equal(compatible.body.compatible, true);
  assert.deepEqual(compatible.body.concerns, []);
  assert.equal(compatible.body.currentHash, "wasm_escrow_v1");
  assert.equal(compatible.body.proposedHash, "wasm_escrow_v2_compatible");
}

// --- check-upgrade: an incompatible pair names each concern ---
{
  const incompatible = handleCheckUpgrade({
    body: { contractId: "escrow-main", proposedHash: "wasm_escrow_v2_broken" },
  });
  assert.equal(incompatible.status, 200);
  assert.equal(incompatible.body.compatible, false);
  assert.equal(incompatible.body.concerns.length, 2);
  assert.ok(
    incompatible.body.concerns.some((c) => c.includes("storage schema version would downgrade")),
  );
  assert.ok(incompatible.body.concerns.some((c) => c.includes("'release' would be removed")));
}

// --- A signature change on a surviving function is also flagged ---
{
  const result = handleCheckUpgrade({
    body: { contractId: "vault-main", proposedHash: "wasm_vault_v1" },
  });
  // Upgrading to the identical hash is trivially compatible.
  assert.equal(result.body.compatible, true);
}

// --- Unknown contract or wasm hash ---
{
  assert.equal(
    handleCheckUpgrade({ body: { contractId: "nope", proposedHash: "wasm_escrow_v1" } }).status,
    404,
  );
  assert.equal(
    handleCheckUpgrade({ body: { contractId: "escrow-main", proposedHash: "nope" } }).status,
    404,
  );
}

// --- Malformed input ---
{
  assert.equal(handleCheckUpgrade({ body: {} }).status, 400);
  assert.equal(handleCheckUpgrade({ body: { contractId: "escrow-main" } }).status, 400);
}

console.log("PASS: upgrade compatibility suite (current-version, check-upgrade)");
