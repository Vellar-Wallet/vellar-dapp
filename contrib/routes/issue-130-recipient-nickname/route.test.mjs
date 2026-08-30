import assert from "node:assert/strict";
import { handleNicknameMapRequest } from "./route.mjs";

const VALID_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLXF3WGC6W263L2B";

// Success: valid nickname + address is confirmed and echoed back.
let { status, payload } = handleNicknameMapRequest({ nickname: "mom", address: VALID_ADDRESS });
assert.equal(status, 201);
assert.equal(payload.confirmed, true);
assert.equal(payload.nickname, "mom");
assert.equal(payload.address, VALID_ADDRESS);

// Missing nickname.
({ status, payload } = handleNicknameMapRequest({ address: VALID_ADDRESS }));
assert.equal(status, 400);
assert.equal(payload.error, "nickname_required");

// Missing address.
({ status, payload } = handleNicknameMapRequest({ nickname: "mom" }));
assert.equal(status, 400);
assert.equal(payload.error, "address_required");

// Malformed address (wrong length).
({ status, payload } = handleNicknameMapRequest({ nickname: "mom", address: "GTOO SHORT" }));
assert.equal(status, 400);
assert.equal(payload.error, "malformed_address");

// Malformed address (does not start with G).
({ status, payload } = handleNicknameMapRequest({
  nickname: "mom",
  address: "A" + VALID_ADDRESS.slice(1),
}));
assert.equal(status, 400);
assert.equal(payload.error, "malformed_address");

// Missing body entirely.
({ status, payload } = handleNicknameMapRequest(undefined));
assert.equal(status, 400);
assert.equal(payload.error, "invalid_body");

console.log("PASS: /recipient-nickname handles valid mapping, missing fields, and malformed address");
