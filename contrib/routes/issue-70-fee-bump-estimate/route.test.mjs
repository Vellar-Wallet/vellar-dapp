import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const TX_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

// Low priority pulls the low value from the fixed lookup table.
const low = handleRequest({ txHash: TX_HASH, priority: "low" });
assert.equal(low.status, 200);
assert.equal(low.body.suggestedFee, 100);

// Medium priority pulls the medium value.
const medium = handleRequest({ txHash: TX_HASH, priority: "medium" });
assert.equal(medium.status, 200);
assert.equal(medium.body.suggestedFee, 500);

// High priority pulls the high value.
const high = handleRequest({ txHash: TX_HASH, priority: "high" });
assert.equal(high.status, 200);
assert.equal(high.body.suggestedFee, 2000);

// Missing txHash and invalid priority are rejected.
assert.equal(handleRequest({ priority: "low" }).status, 400);
assert.equal(handleRequest({ txHash: TX_HASH, priority: "urgent" }).status, 400);
assert.equal(handleRequest({ txHash: "not-hex!!" , priority: "low" }).status, 400);

console.log("PASS: /fee-bump-estimate returns lookup-table fees for low, medium, and high priority");
