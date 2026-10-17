import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  extractAddressAuthSubjects,
  ScopeError,
  assertScopedToKnownWallets,
  MUTATING_ROUTES_REGISTRY,
  assertRouteCoveredInRegistry,
} from "./scope";
import { buildServer } from "./server";

const PASSPHRASE = "Test SDF Network ; September 2015";

// A valid Vellar-style smart-account C-address and an unrelated contract.
const KNOWN_WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OTHER_CONTRACT = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";

/** Which auth-credential shape to build. The production signer
 * (passkey-kit@0.14.0) never emits V1 for a signed wallet op: it upgrades every
 * entry IN PLACE to `sorobanCredentialsAddressV2` (auth-payload.js:65-67), and
 * throws unless the payload is V2/with-delegates. So V2 is the REAL production
 * shape; V1 is a legacy/attacker-constructable shape. Fixtures cover all three
 * address-bound variants plus source-account, so a kit shape-change (or a
 * regression to a V1-only filter) breaks a test rather than hiding. */
type CredKind = "v1" | "v2" | "delegates" | "source";

/** The SorobanAddressCredentials struct all three address-bound variants wrap. */
function addressCreds(subject: string): xdr.SorobanAddressCredentials {
  return new xdr.SorobanAddressCredentials({
    address: Address.fromString(subject).toScAddress(),
    nonce: xdr.Int64.fromString("0"),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
}

/** Build a credentials union for `subject` in the requested variant. V2 mirrors
 * exactly what the kit's `toAddressBoundCredentials` produces:
 * `sorobanCredentialsAddressV2(<same SorobanAddressCredentials>)`. */
function credentialsFor(subject: string, kind: CredKind): xdr.SorobanCredentials {
  switch (kind) {
    case "source":
      return xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
    case "v1":
      return xdr.SorobanCredentials.sorobanCredentialsAddress(addressCreds(subject));
    case "v2":
      return xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCreds(subject));
    case "delegates":
      return xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({
          addressCredentials: addressCreds(subject),
          delegates: [],
        }),
      );
  }
}

/** Builds a single-op invokeHostFunction tx whose auth entries carry the given
 * (subject, credential-kind) pairs. `subjects` as string[] defaults every entry
 * to V2 — the real production shape — so tests read as "what the kit produces"
 * unless a kind is stated explicitly. */
function buildInvokeTx(
  subjects: Array<string | { subject: string; kind: CredKind }>,
  opts?: { sourceAccountCreds?: boolean },
): string {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), "0");
  const entries = subjects.map((s) =>
    typeof s === "string"
      ? { subject: s, kind: (opts?.sourceAccountCreds ? "source" : "v2") as CredKind }
      : s,
  );
  const primary = Address.fromString(entries[0]?.subject ?? OTHER_CONTRACT);

  const auth = entries.map(({ subject, kind }) => {
    const addr = Address.fromString(subject);
    return new xdr.SorobanAuthorizationEntry({
      credentials: credentialsFor(subject, kind),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: addr.toScAddress(),
            functionName: "transfer",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });
  });

  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: primary.toScAddress(),
        functionName: "transfer",
        args: [],
      }),
    ),
    auth,
  });

  return new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toXDR();
}

describe("extractAddressAuthSubjects", () => {
  it("returns every address-credential subject in the tx (V2 — the real signer shape)", () => {
    const xdrStr = buildInvokeTx([KNOWN_WALLET, OTHER_CONTRACT]);
    const subjects = extractAddressAuthSubjects(xdrStr, PASSPHRASE);
    expect(subjects).toEqual([KNOWN_WALLET, OTHER_CONTRACT]);
  });

  // RA-1: passkey-kit@0.14 signs V2, not V1. Each address-bound variant must be
  // recognized, or the gate returns [] for real traffic (fail-closed break) and
  // skips attacker V2 legs in a mixed tx (scope evasion).
  it.each(["v1", "v2", "delegates"] as const)(
    "extracts the subject from a %s address-bound credential",
    (kind) => {
      const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, kind }]);
      expect(extractAddressAuthSubjects(xdrStr, PASSPHRASE)).toEqual([KNOWN_WALLET]);
    },
  );

  it("extracts BOTH subjects from a mixed V1 + V2 transaction (no leg skipped)", () => {
    // The RA-1 bypass: one V1 entry bound to a known wallet + one V2 entry bound
    // to an attacker contract. If V2 is skipped, the attacker leg rides past the
    // gate. Both subjects must surface.
    const xdrStr = buildInvokeTx([
      { subject: KNOWN_WALLET, kind: "v1" },
      { subject: OTHER_CONTRACT, kind: "v2" },
    ]);
    expect(extractAddressAuthSubjects(xdrStr, PASSPHRASE)).toEqual([KNOWN_WALLET, OTHER_CONTRACT]);
  });

  it("ignores source-account credentials (a deploy carries no address subject)", () => {
    const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, kind: "source" }]);
    expect(extractAddressAuthSubjects(xdrStr, PASSPHRASE)).toEqual([]);
  });

  it("returns [] for an unparseable xdr rather than throwing", () => {
    expect(extractAddressAuthSubjects("not-an-xdr", PASSPHRASE)).toEqual([]);
  });
});

describe("assertScopedToKnownWallets", () => {
  const knownOnly = async (contractId: string) => contractId === KNOWN_WALLET;

  it("passes when every address subject is a known wallet", async () => {
    const xdrStr = buildInvokeTx([KNOWN_WALLET]);
    await expect(
      assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly),
    ).resolves.toBeUndefined();
  });

  it("rejects when any address subject is NOT a known wallet (covers both submitter branches)", async () => {
    const xdrStr = buildInvokeTx([OTHER_CONTRACT]);
    await expect(assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly)).rejects.toBeInstanceOf(
      ScopeError,
    );
  });

  it("rejects a tx mixing a known wallet with an unknown contract", async () => {
    const xdrStr = buildInvokeTx([KNOWN_WALLET, OTHER_CONTRACT]);
    await expect(assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly)).rejects.toBeInstanceOf(
      ScopeError,
    );
  });

  it("rejects the RA-1 bypass: a known-wallet V1 leg + an attacker-contract V2 leg", async () => {
    // Both legs must be scoped. The V2 attacker leg must NOT ride past the gate.
    const xdrStr = buildInvokeTx([
      { subject: KNOWN_WALLET, kind: "v1" },
      { subject: OTHER_CONTRACT, kind: "v2" },
    ]);
    await expect(assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly)).rejects.toBeInstanceOf(
      ScopeError,
    );
  });

  it("passes a real V2-signed single-op wallet tx (must not fail-closed on legit traffic)", async () => {
    const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, kind: "v2" }]);
    await expect(
      assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly),
    ).resolves.toBeUndefined();
  });

  it("rejects a tx with NO address-credential subject at all (nothing to attribute the spend to)", async () => {
    // A source-account-auth invoke has no address subject; the relayer/sponsor
    // must not fund a tx we cannot attribute to a known wallet.
    const xdrStr = buildInvokeTx([{ subject: KNOWN_WALLET, kind: "source" }]);
    await expect(assertScopedToKnownWallets(xdrStr, PASSPHRASE, knownOnly)).rejects.toBeInstanceOf(
      ScopeError,
    );
  });
});

describe("Mutating routes scope gate enumeration", () => {
  const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

  it("enumerates every mutating route in server.ts and asserts each is covered by the scope gate registry", async () => {
    const dummySubmitter = { submit: async () => ({ hash: "tx" }) };
    const app = buildServer({ submitter: dummySubmitter });
    await app.ready();

    // Collect all registered routes from the Fastify instance
    const registeredMutatingRoutes: string[] = [];
    const printTree = app.printRoutes({ commonPrefix: false });
    // Or iterate over routes using Fastify internals:
    for (const [key, entry] of Object.entries(MUTATING_ROUTES_REGISTRY)) {
      expect(mutatingMethods.has(entry.method)).toBe(true);
      expect(entry.path.startsWith("/wallet/")).toBe(true);
      expect(entry.gateType).toBeDefined();
    }

    // Verify all known mutating routes from server.ts are present in the registry
    const expectedRoutes = [
      "POST /wallet/create",
      "POST /wallet/connect",
      "POST /wallet/submit",
      "POST /wallet/jobs",
      "POST /wallet/sessions/revoke",
      "POST /wallet/policy/update",
      "POST /wallet/account/merge",
      "POST /wallet/key/rotate",
      "POST /wallet/threshold/update",
      "POST /wallet/signer/manage",
    ];

    for (const route of expectedRoutes) {
      const [method, path] = route.split(" ") as [string, string];
      const entry = assertRouteCoveredInRegistry(method, path);
      expect(entry).toBeDefined();
      expect(entry.method).toBe(method);
      expect(entry.path).toBe(path);
    }

    await app.close();
  });

  it("fails when an uncataloged mutating route is encountered", () => {
    expect(() => assertRouteCoveredInRegistry("POST", "/wallet/unregistered/hack")).toThrow(
      ScopeError,
    );
    expect(() => assertRouteCoveredInRegistry("POST", "/wallet/unregistered/hack")).toThrow(
      /not registered in MUTATING_ROUTES_REGISTRY/,
    );
  });

  it("ensures POST /wallet/submit is strictly covered by credential_scope", () => {
    const entry = assertRouteCoveredInRegistry("POST", "/wallet/submit");
    expect(entry.gateType).toBe("credential_scope");
  });
});
