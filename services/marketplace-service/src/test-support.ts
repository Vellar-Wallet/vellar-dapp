import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { REGISTRATION_DATA_KEY } from "./lib/signature";
import type {
  FacilitatorApi,
  ResourceListResponse,
  SearchResponse,
  FacilitatorResource,
} from "./lib/facilitator";

// Shared fixtures for the marketplace route tests.

export const TEST_PASSPHRASE = Networks.TESTNET;

/** Builds a real signed envelope — the signature checks are genuine crypto, so
 * the tests must produce genuinely signed XDR rather than stub the verifier. */
export function signedRegistrationXdr(
  keypair: Keypair,
  nonce: string,
  options: { dataKey?: string; extraOp?: boolean; passphrase?: string } = {},
): string {
  const account = new Account(keypair.publicKey(), "1");
  const builder = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: options.passphrase ?? TEST_PASSPHRASE,
  }).addOperation(
    Operation.manageData({
      name: options.dataKey ?? REGISTRATION_DATA_KEY,
      value: Buffer.from(nonce, "utf8"),
    }),
  );
  if (options.extraOp) {
    builder.addOperation(Operation.manageData({ name: "extra", value: Buffer.from("x") }));
  }
  const tx = builder.setTimeout(300).build();
  tx.sign(keypair);
  return tx.toXDR();
}

/** A signed envelope with no registration payload — the "prove key control"
 * shape used by payments and listing updates. */
export function signedProofXdr(keypair: Keypair, passphrase: string = TEST_PASSPHRASE): string {
  const account = new Account(keypair.publicKey(), "1");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: passphrase })
    .addOperation(Operation.manageData({ name: "vellar-proof", value: Buffer.from("ok") }))
    .setTimeout(300)
    .build();
  tx.sign(keypair);
  return tx.toXDR();
}

export function resource(overrides: Partial<FacilitatorResource> = {}): FacilitatorResource {
  return {
    resourceUrl: "https://api.example.com/weather",
    title: "Weather API",
    description: "Forecast data",
    scheme: "exact",
    asset: "USDC",
    network: "testnet",
    priceAtomic: "1000",
    payTo: undefined,
    areFeesSponsored: undefined,
    lastUpdated: undefined,
    raw: {},
    ...overrides,
  };
}

export interface StubFacilitatorOverrides {
  getResources?: (params: unknown) => Promise<ResourceListResponse>;
  searchResources?: (query: string, limit?: number) => Promise<SearchResponse>;
  getResource?: (resourceUrl: string) => Promise<FacilitatorResource>;
  verify?: (payload: unknown) => Promise<Record<string, unknown>>;
  settle?: (payload: unknown) => Promise<Record<string, unknown>>;
}

export function stubFacilitator(overrides: StubFacilitatorOverrides = {}): FacilitatorApi {
  return {
    getResources: overrides.getResources ?? (async () => ({ resources: [resource()] })),
    searchResources:
      overrides.searchResources ??
      (async (query: string) => ({ resources: [resource()], query, partialResults: false })),
    getResource: overrides.getResource ?? (async () => resource()),
    verify: overrides.verify ?? (async () => ({ isValid: true })),
    settle:
      overrides.settle ??
      (async () => ({
        content: "sunny",
        txHash: "abc123",
        ledger: 42,
        amountPaid: "1000",
        asset: "USDC",
      })),
  } as FacilitatorApi;
}
