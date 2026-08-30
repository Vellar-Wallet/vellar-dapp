import assert from "node:assert/strict";
import { listNetworks, getNetworkConfig, resolveNetworkName, handleRequest } from "./route.mjs";

// List: advertises exactly the canonical names, not the aliases.
const list = listNetworks();
assert.equal(list.status, 200);
assert.deepEqual(list.payload.supported, ["testnet", "mainnet"]);
assert.equal(list.payload.networks.length, 2);
assert.equal(list.payload.networks[0].label, "Stellar Testnet");

// Lookup: testnet returns the sample rpc url and passphrase.
const testnet = getNetworkConfig("testnet");
assert.equal(testnet.status, 200);
assert.equal(testnet.payload.network, "testnet");
assert.equal(testnet.payload.networkPassphrase, "Test SDF Network ; September 2015");
assert.equal(testnet.payload.rpcUrl, "https://soroban-testnet.stellar.org");
assert.equal(testnet.payload.horizonUrl, "https://horizon-testnet.stellar.org");
assert.equal(testnet.payload.isTestNetwork, true);

// Lookup: mainnet carries the other passphrase and has no friendbot.
const mainnet = getNetworkConfig("mainnet");
assert.equal(mainnet.status, 200);
assert.equal(mainnet.payload.networkPassphrase, "Public Global Stellar Network ; September 2015");
assert.equal(mainnet.payload.isTestNetwork, false);
assert.equal(mainnet.payload.friendbotUrl, null);

// The two networks must never share a passphrase — that pairing is the whole
// point of the lookup.
assert.notEqual(testnet.payload.networkPassphrase, mainnet.payload.networkPassphrase);

// Names are case-insensitive and tolerate surrounding whitespace.
assert.equal(getNetworkConfig("  TESTNET ").payload.network, "testnet");
assert.equal(resolveNetworkName("MainNet"), "mainnet");

// Aliases resolve to their canonical network.
assert.equal(getNetworkConfig("public").payload.network, "mainnet");
assert.equal(getNetworkConfig("test").payload.network, "testnet");
assert.equal(resolveNetworkName("pubnet"), "mainnet");

// The echoed `requested` keeps the caller's spelling, not the resolved one.
assert.equal(getNetworkConfig("public").payload.requested, "public");

// Unknown / malformed names are rejected with the supported list.
const unknown = getNetworkConfig("regtest");
assert.equal(unknown.status, 404);
assert.equal(unknown.payload.error, "unsupported_network");
assert.deepEqual(unknown.payload.supported, ["testnet", "mainnet"]);
assert.equal(getNetworkConfig("").status, 404);
assert.equal(getNetworkConfig(undefined).status, 404);
assert.equal(resolveNetworkName(null), null);

// A mutated response must not corrupt the table for the next caller.
const first = getNetworkConfig("testnet");
first.payload.rpcUrl = "https://evil.example";
assert.equal(getNetworkConfig("testnet").payload.rpcUrl, "https://soroban-testnet.stellar.org");

// Routing: paths map to the right handlers, anything else is a 404.
assert.equal(handleRequest("GET", "/networks").status, 200);
assert.equal(handleRequest("GET", "/networks/testnet").payload.network, "testnet");
assert.equal(handleRequest("GET", "/networks/nope").status, 404);
assert.equal(handleRequest("POST", "/networks").status, 404);
assert.equal(handleRequest("GET", "/other").status, 404);

console.log(
  "PASS: /networks lists supported networks and /networks/:name returns rpc url + passphrase, with aliases and unknown-name rejection",
);
