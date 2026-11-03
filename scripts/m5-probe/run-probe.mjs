#!/usr/bin/env node
// M5 on-chain probe (docs/design-m5-threshold-attestor.md). Repeatable, testnet only.
//
//   pnpm --filter @vellar/m5-probe probe
//
// It builds the probe crate (cargo, --locked), deploys it to TESTNET with a fresh
// throwaway key funded by friendbot (no secrets, nothing shared with any real key),
// and checks, against the real Soroban host:
//   1. PROTOCOL CANARY: what a custom account's __check_auth may do (write instance
//      and persistent storage, extend a TTL, emit an event, read).
//   2. The single-signer revoke cap rules on real authorisation contexts.
//   3. ROLLBACK: a revoke that is authorised and then fails in the registry call
//      leaves the signer's counter unchanged.
// Exit code 1 if ANY assumption no longer holds, so a protocol upgrade that changes
// the behaviour is caught by re-running it. Writes results.json next to this file.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The Stellar SDK is resolved from the wallet-service workspace package, so this
// script needs no package.json, workspace entry or lockfile change of its own.
const require = createRequire(
  new URL("../../services/wallet-service/package.json", import.meta.url),
);
const {
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} = require("@stellar/stellar-sdk");

// Protocol versions this probe has passed on. A run on any other version still has to pass
// every check; this only flags that the result is new and the design doc should be updated.
const VERIFIED_PROTOCOLS = [29];

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RPC_URL = process.env.M5_PROBE_RPC_URL ?? "https://soroban-testnet.stellar.org";
const MAINNET_RPC_URL = "https://mainnet.sorobanrpc.com";
const WASM = `${HERE}target/wasm32v1-none/release/vellar_m5_probe.wasm`;

const server = new rpc.Server(RPC_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Refuse to run anywhere but testnet.
// ---------------------------------------------------------------------------
const network = await server.getNetwork();
if (network.passphrase !== Networks.TESTNET) {
  console.error(
    `Refusing to run: ${RPC_URL} is not the Stellar testnet (passphrase ${network.passphrase}).`,
  );
  process.exit(2);
}
const PASS = Networks.TESTNET;
const protocols = { testnet: network.protocolVersion };
try {
  protocols.mainnet = (await new rpc.Server(MAINNET_RPC_URL).getNetwork()).protocolVersion;
} catch {
  protocols.mainnet = "unreachable";
}

// ---------------------------------------------------------------------------
// Build, key, deploy.
// ---------------------------------------------------------------------------
if (!process.env.M5_PROBE_SKIP_BUILD) {
  execFileSync("cargo", ["build", "--release", "--target", "wasm32v1-none", "--locked"], {
    cwd: HERE,
    stdio: "inherit",
  });
}
const wasm = readFileSync(WASM);

const kp = Keypair.random();
await server.requestAirdrop(kp.publicKey());
for (let i = 0; i < 20; i++) {
  try {
    await server.getAccount(kp.publicKey());
    break;
  } catch {
    await sleep(1500);
  }
}

async function wait(hashHex) {
  for (let i = 0; i < 60; i++) {
    const r = await server.getTransaction(hashHex);
    if (r.status !== "NOT_FOUND") return r;
    await sleep(1500);
  }
  throw new Error("timed out waiting for " + hashHex);
}

async function submit(operation) {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: "10000000", networkPassphrase: PASS })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR")
    throw new Error("send rejected: " + JSON.stringify(sent.errorResult));
  const done = await wait(sent.hash);
  if (done.status !== "SUCCESS") throw new Error("transaction failed: " + sent.hash);
  return done;
}

const optAddr = (a) => (a ? new Address(a).toScVal() : xdr.ScVal.scvVoid());

async function deploy({ registry = null, failAfterAuth = false, nestInto = null }) {
  const wasmHash = hash(wasm);
  await submit(Operation.uploadContractWasm({ wasm })).catch(() => {}); // already uploaded is fine
  const done = await submit(
    Operation.createCustomContract({
      address: new Address(kp.publicKey()),
      wasmHash,
      salt: Buffer.from(Keypair.random().rawPublicKey()),
      constructorArgs: [
        optAddr(registry),
        nativeToScVal(failAfterAuth, { type: "bool" }),
        optAddr(nestInto),
      ],
    }),
  );
  return scValToNative(done.returnValue);
}

const WASM_HASH = hash(wasm);
const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: WASM_HASH }));
const instanceKeyOf = (id) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(id).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
const ringKeyOf = (id, signer) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(id).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Ring"), nativeToScVal(signer, { type: "u32" })]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
const revokedKeyOf = (id, record) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(id).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Revoked"), new Address(record).toScVal()]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

// ---------------------------------------------------------------------------
// Authorised invocation helpers.
// ---------------------------------------------------------------------------
const sym = (s) => xdr.ScVal.scvSymbol(s);
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const SIG = {
  mode: (n) => xdr.ScVal.scvVec([sym("Mode"), u32(n)]),
  single: (i) => xdr.ScVal.scvVec([sym("Single"), u32(i)]),
  pair: () => xdr.ScVal.scvVec([sym("Pair")]),
};

function addrCreds(entry) {
  const c = entry.credentials();
  switch (c.switch().name) {
    case "sorobanCredentialsAddress":
      return c.address();
    case "sorobanCredentialsAddressV2":
      return c.addressV2();
    default:
      return undefined; // source-account credentials
  }
}
const subjectOf = (entry) => {
  const c = addrCreds(entry);
  return c ? Address.fromScAddress(c.address()).toString() : undefined;
};

async function buildTx(target, fn, args, auth, extra = {}) {
  const account = await server.getAccount(kp.publicKey());
  const b = new TransactionBuilder(account, {
    fee: extra.fee ?? "10000000",
    networkPassphrase: PASS,
  })
    .addOperation(Operation.invokeContractFunction({ contract: target, function: fn, args, auth }))
    .setTimeout(120);
  if (extra.sorobanData) b.setSorobanData(extra.sorobanData);
  return b.build();
}

async function view(target, fn, args = []) {
  const tx = await buildTx(target, fn, args, []);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`view ${fn} failed: ${sim.error}`);
  return scValToNative(sim.result.retval);
}

/** The headline host error, e.g. "Error(Auth, InvalidAction)" or "Error(Contract, #5)". */
const topError = (text) => (/Error\([A-Za-z]+, [^)]+\)/.exec(text ?? "") ?? [])[0];

const contractErrorCode = (text) => {
  const m = /Error\(Contract, #(\d+)\)/.exec(text ?? "");
  return m ? Number(m[1]) : undefined;
};

function contractCodesFrom(txResult) {
  const found = [];
  const scan = (v) => {
    try {
      if (v.switch().name === "scvError" && v.error().switch().name === "sceContract") {
        found.push(v.error().contractCode());
      }
    } catch {}
  };
  try {
    for (const ev of txResult.diagnosticEventsXdr ?? []) {
      const body = ev.event().body().v0();
      body.topics().forEach(scan);
      scan(body.data());
    }
  } catch {}
  return found;
}

/** An authorisation entry for `account` calling `fn` on `target`, borrowing the credential variant of a recorded one. */
function manualEntry(template, account, target, fn, args) {
  const e = xdr.SorobanAuthorizationEntry.fromXDR(template.toXDR());
  addrCreds(e).address(new Address(account).toScAddress());
  e.rootInvocation(
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(target).toScAddress(),
          functionName: fn,
          args,
        }),
      ),
      subInvocations: [],
    }),
  );
  return e;
}

/**
 * Invoke `fn` on `target`, authorised for `account` with signature `sig`.
 * If the host accepts it at simulation: send it, and report "applied".
 * If the host refuses it: there is no transaction to point at, so force one on-chain
 * with a hand-widened footprint and report that FAILED transaction too.
 */
async function authorised({ target, fn, args, account, sig, footprint, manualFrom }) {
  // Normally the recording-mode simulation hands us the authorisation entry. When the
  // call itself fails on purpose (the rollback case) that simulation errors before
  // producing one, so the entry is built by hand from a recorded template instead.
  let recordedAuth;
  if (manualFrom) {
    recordedAuth = [manualEntry(manualFrom, account, target, fn, args)];
  } else {
    const recorded = await server.simulateTransaction(await buildTx(target, fn, args, []));
    if (rpc.Api.isSimulationError(recorded))
      throw new Error("recording simulation failed: " + recorded.error);
    recordedAuth = recorded.result.auth;
  }
  const latest = (await server.getLatestLedger()).sequence;
  const auth = recordedAuth.map((entry) => {
    if (subjectOf(entry) !== account) return entry;
    const e = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    const creds = addrCreds(e);
    creds.nonce(xdr.Int64.fromString(String(Math.floor(Math.random() * 1e15))));
    creds.signatureExpirationLedger(latest + 300);
    creds.signature(sig);
    return e;
  });

  const tx = await buildTx(target, fn, args, auth);
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationError(sim)) {
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(kp);
    const sent = await server.sendTransaction(prepared);
    const done = await wait(sent.hash);
    return {
      kind: "applied",
      hash: sent.hash,
      status: done.status,
      ledger: done.ledger,
      result: done,
    };
  }

  const data = new SorobanDataBuilder();
  data.setFootprint([codeKey], footprint);
  data.setResources(20_000_000, 40_000, 40_000);
  data.setResourceFee(20_000_000n);
  const forced = await buildTx(target, fn, args, auth, {
    fee: "40000000",
    sorobanData: data.build(),
  });
  forced.sign(kp);
  const sent = await server.sendTransaction(forced);
  let done;
  if (sent.status === "ERROR") {
    done = { status: "NOT_ACCEPTED", resultXdr: undefined, diagnosticEventsXdr: [] };
  } else {
    done = await wait(sent.hash);
  }
  return {
    kind: "refused",
    simError: sim.error.replace(/\s+/g, " ").slice(0, 200),
    simCode: contractErrorCode(sim.error),
    simTop: topError(sim.error),
    hash: sent.hash,
    status: done.status,
    ledger: done.ledger,
    forcedCodes: contractCodesFrom(done),
  };
}

// ---------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------
const checks = [];
const rows = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
}
const lenOf = (v) => (Array.isArray(v) ? v.length : -1);

console.log(`protocol: testnet ${protocols.testnet}, mainnet ${protocols.mainnet}`);
console.log("deploying probe contracts to testnet ...");
const R1 = await deploy({});
const R2 = await deploy({});
const R_FAIL = await deploy({ failAfterAuth: true });
const R_NEST = await deploy({ nestInto: R2 });
const A = await deploy({ registry: R1 });
const A_FAIL = await deploy({ registry: R_FAIL });
const A_NEST = await deploy({ registry: R_NEST });
const CANARY = await deploy({});
const RECORD = kp.publicKey();
console.log({ R1, R2, R_FAIL, R_NEST, A, A_FAIL, A_NEST, CANARY });

const instances = (...ids) => ids.map(instanceKeyOf);

// 1. PROTOCOL CANARY -------------------------------------------------------
const before = {
  counter: await view(CANARY, "counter"),
  persisted: await view(CANARY, "persisted"),
  ttl: (await server.getLedgerEntries(instanceKeyOf(CANARY))).entries[0].liveUntilLedgerSeq,
};
const modeTx = {};
for (const [mode, label] of [
  [0, "nothing (control)"],
  [1, "write instance storage"],
  [2, "write persistent storage"],
  [3, "extend instance TTL"],
  [4, "publish an event"],
  [5, "read storage"],
]) {
  const r = await authorised({
    target: CANARY,
    fn: "ping",
    args: [],
    account: CANARY,
    sig: SIG.mode(mode),
    footprint: instances(CANARY),
  });
  modeTx[mode] = r;
  rows.push({
    section: "canary",
    name: `mode ${mode}: ${label}`,
    hash: r.hash,
    outcome: `${r.kind}/${r.status}`,
  });
  check(
    `canary mode ${mode} (${label}) is accepted and applied`,
    r.kind === "applied" && r.status === "SUCCESS",
    `${r.kind}/${r.status} ${r.hash.slice(0, 10)}`,
  );
}
const after = {
  counter: await view(CANARY, "counter"),
  persisted: await view(CANARY, "persisted"),
  ttl: (await server.getLedgerEntries(instanceKeyOf(CANARY))).entries[0].liveUntilLedgerSeq,
};
check("canary: the control left state unchanged", before.counter === 0 && before.persisted === 0);
check(
  "canary: __check_auth wrote instance storage",
  after.counter === 1,
  `counter ${before.counter} -> ${after.counter}`,
);
check(
  "canary: __check_auth wrote persistent storage",
  after.persisted === 1,
  `persisted ${before.persisted} -> ${after.persisted}`,
);
check(
  "canary: __check_auth extended the instance TTL",
  after.ttl > before.ttl + 1_000_000,
  `ttl ${before.ttl} -> ${after.ttl}`,
);
const ev = await server.getEvents({
  startLedger: modeTx[4].ledger,
  endLedger: modeTx[4].ledger + 1,
  filters: [{ type: "contract", contractIds: [CANARY] }],
  limit: 10,
});
check(
  "canary: __check_auth emitted a contract event",
  ev.events.length >= 1,
  `${ev.events.length} event(s)`,
);

// 2. HAPPY PATH AND THE CAP ------------------------------------------------
const revokeVia = (registry, attestor, record, sig, extraKeys = []) =>
  authorised({
    target: registry,
    fn: "revoke",
    args: [new Address(attestor).toScVal(), new Address(record).toScVal()],
    account: attestor,
    sig,
    footprint: [
      ...instances(registry, attestor),
      ringKeyOf(attestor, 0),
      ringKeyOf(attestor, 1),
      ringKeyOf(attestor, 2),
      revokedKeyOf(registry, record),
      ...extraKeys,
    ],
  });

const records = [
  Keypair.random().publicKey(),
  Keypair.random().publicKey(),
  Keypair.random().publicKey(),
  Keypair.random().publicKey(),
  Keypair.random().publicKey(),
];

for (let i = 0; i < 3; i++) {
  const r = await revokeVia(R1, A, records[i], SIG.single(0));
  rows.push({
    section: "cap",
    name: `signer 0 revoke #${i + 1}`,
    hash: r.hash,
    outcome: `${r.kind}/${r.status}`,
  });
  check(
    `cap: signer 0 single-signature revoke #${i + 1} is accepted`,
    r.kind === "applied" && r.status === "SUCCESS",
    r.hash.slice(0, 10),
  );
}
check(
  "cap: after 3 accepted revokes the ring holds 3 ledgers",
  lenOf(await view(A, "ring", [u32(0)])) === 3,
);
check(
  "cap: the registry recorded the revoked record",
  (await view(R1, "revoked", [new Address(records[0]).toScVal()])) === true,
);

const fourth = await revokeVia(R1, A, records[3], SIG.single(0));
rows.push({
  section: "cap",
  name: "signer 0 revoke #4 (over the cap)",
  hash: fourth.hash,
  outcome: `${fourth.kind}/${fourth.status}`,
});
check(
  "cap: the 4th single-signature revoke is REFUSED by the host: Auth InvalidAction, CapReached (#2)",
  fourth.kind === "refused" &&
    fourth.simTop === "Error(Auth, InvalidAction)" &&
    fourth.simCode === 2,
  `${fourth.simTop} / contract #${fourth.simCode}`,
);
check(
  "cap: the forced transaction for the 4th revoke FAILED on-chain",
  fourth.kind === "refused" && fourth.status === "FAILED",
  fourth.hash.slice(0, 10),
);
check(
  "cap: a refused 4th revoke leaves the ring at 3",
  lenOf(await view(A, "ring", [u32(0)])) === 3,
);
check(
  "cap: a refused 4th revoke did not revoke the record",
  (await view(R1, "revoked", [new Address(records[3]).toScVal()])) === false,
);

const pair = await revokeVia(R1, A, records[3], SIG.pair());
rows.push({
  section: "cap",
  name: "two-signature revoke after exhaustion",
  hash: pair.hash,
  outcome: `${pair.kind}/${pair.status}`,
});
check(
  "cap: a two-signature revoke still works after the signer is exhausted",
  pair.kind === "applied" && pair.status === "SUCCESS",
  pair.hash.slice(0, 10),
);
check(
  "cap: a two-signature revoke consumed no allowance",
  lenOf(await view(A, "ring", [u32(0)])) === 3,
);
check(
  "cap: the two-signature revoke did revoke the record",
  (await view(R1, "revoked", [new Address(records[3]).toScVal()])) === true,
);

const other = await revokeVia(R1, A, records[4], SIG.single(1));
rows.push({
  section: "cap",
  name: "signer 1 revoke (independent allowance)",
  hash: other.hash,
  outcome: `${other.kind}/${other.status}`,
});
check(
  "cap: signer 1 has its own allowance and is unaffected by signer 0",
  other.kind === "applied" && other.status === "SUCCESS",
  other.hash.slice(0, 10),
);

// 3. CONTEXT RULES ON REAL CONTEXTS (signer 2 is unused, so only the context can refuse)
async function mustRefuse(name, run, ring) {
  const r = await run();
  rows.push({ section: "context", name, hash: r.hash, outcome: `${r.kind}/${r.status}` });
  check(
    `context: ${name} is refused: Auth InvalidAction, WrongContext (#3)`,
    r.kind === "refused" && r.simTop === "Error(Auth, InvalidAction)" && r.simCode === 3,
    `${r.simTop} / contract #${r.simCode}`,
  );
  check(
    `context: ${name} FAILED on-chain`,
    r.kind === "refused" && r.status === "FAILED",
    (r.hash ?? "").slice(0, 10),
  );
  check(
    `context: ${name} did not touch the signer's counter`,
    lenOf(await view(ring.id, "ring", [u32(2)])) === 0,
  );
}

await mustRefuse(
  "a different function on the bound registry (upsert)",
  () =>
    authorised({
      target: R1,
      fn: "upsert",
      args: [new Address(A).toScVal(), new Address(RECORD).toScVal()],
      account: A,
      sig: SIG.single(2),
      footprint: [...instances(R1, A), ringKeyOf(A, 2), revokedKeyOf(R1, RECORD)],
    }),
  { id: A },
);

await mustRefuse(
  "revoke on a different registry address",
  () =>
    authorised({
      target: R2,
      fn: "revoke",
      args: [new Address(A).toScVal(), new Address(RECORD).toScVal()],
      account: A,
      sig: SIG.single(2),
      footprint: [...instances(R2, A), ringKeyOf(A, 2), revokedKeyOf(R2, RECORD)],
    }),
  { id: A },
);

await mustRefuse(
  "an extra context in the same authorisation (revoke that nests a second authorised call)",
  () =>
    authorised({
      target: R_NEST,
      fn: "revoke",
      args: [new Address(A_NEST).toScVal(), new Address(RECORD).toScVal()],
      account: A_NEST,
      sig: SIG.single(2),
      footprint: [
        ...instances(R_NEST, R2, A_NEST),
        ringKeyOf(A_NEST, 2),
        revokedKeyOf(R_NEST, RECORD),
        revokedKeyOf(R2, RECORD),
      ],
    }),
  { id: A_NEST },
);

// 4. ROLLBACK: authorised, then the registry call fails ----------------------
const templateRecording = await server.simulateTransaction(
  await buildTx(R1, "revoke", [new Address(A).toScVal(), new Address(RECORD).toScVal()], []),
);
const template = templateRecording.result.auth.find((a) => subjectOf(a) === A);
const failing = await authorised({
  manualFrom: template,
  target: R_FAIL,
  fn: "revoke",
  args: [new Address(A_FAIL).toScVal(), new Address(RECORD).toScVal()],
  account: A_FAIL,
  sig: SIG.single(0),
  footprint: [...instances(R_FAIL, A_FAIL), ringKeyOf(A_FAIL, 0), revokedKeyOf(R_FAIL, RECORD)],
});
rows.push({
  section: "rollback",
  name: "authorised, then the registry call fails",
  hash: failing.hash,
  outcome: `${failing.kind}/${failing.status}`,
});
// If __check_auth had refused, the headline error would be Auth InvalidAction (as in the
// cap and context cases). A headline of Contract #5 means the authorisation PASSED and the
// failure came from the registry call afterwards.
check(
  "rollback: the failure is the registry's own error (Contract #5), so __check_auth had ALREADY accepted the revoke",
  failing.kind === "refused" && failing.simTop === "Error(Contract, #5)",
  `${failing.simTop}`,
);
check(
  "rollback: the failing transaction FAILED on-chain",
  failing.kind === "refused" && failing.status === "FAILED",
  (failing.hash ?? "").slice(0, 10),
);
check(
  "rollback: a revoke that failed after authorisation did NOT burn the signer's slot",
  lenOf(await view(A_FAIL, "ring", [u32(0)])) === 0,
  "ring(0) is empty",
);
check(
  "rollback: the failed revoke did not revoke the record",
  (await view(R_FAIL, "revoked", [new Address(RECORD).toScVal()])) === false,
);

// ---------------------------------------------------------------------------
if (!VERIFIED_PROTOCOLS.includes(Number(protocols.testnet))) {
  const note = `Protocol ${protocols.testnet} is not in VERIFIED_PROTOCOLS (${VERIFIED_PROTOCOLS.join(", ")}). Every check is judged on this run; if they pass, add ${protocols.testnet} here and to docs/design-m5-threshold-attestor.md.`;
  console.warn(`::warning::${note}`);
  console.warn(note);
}
const failed = checks.filter((c) => !c.ok);
writeFileSync(
  `${HERE}results.json`,
  JSON.stringify(
    {
      rpc: RPC_URL,
      protocols,
      throwawayAccount: kp.publicKey(),
      contracts: { R1, R2, R_FAIL, R_NEST, A, A_FAIL, A_NEST, CANARY },
      wasmSha256: WASM_HASH.toString("hex"),
      rows,
      checks,
    },
    null,
    2,
  ),
);
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed on protocol ${protocols.testnet}. Wrote results.json`,
);
if (failed.length) {
  console.error("FAILED:\n" + failed.map((c) => " - " + c.name).join("\n"));
  process.exit(1);
}
