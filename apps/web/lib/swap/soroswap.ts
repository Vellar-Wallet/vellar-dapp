import type { Network } from "@vellar/types";

// Soroswap venue adapter (docs/design-phase8-payments.md, "Swaps").
//
// Why a Soroban AMM and not the native DEX: a Vellar account is a contract
// (C…). A contract cannot be the source of a classic PathPaymentStrictSend, so
// native-DEX path payments are unreachable from the wallet. Soroswap's router
// is invoked like any other contract, with the wallet's own auth entry, and it
// enforces the slippage floor itself (`amount_out_min`, Error #507).
//
// Quotes come from the router (`router_get_amounts_out`, simulated against
// live pair reserves) — the venue itself, never a price oracle.

// From soroswap/core public/{testnet,mainnet}.contracts.json.
export const SOROSWAP_ROUTER: Record<Network, string> = {
  testnet: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
  mainnet: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
};

/** Seconds the router will still accept the swap after it is built. */
export const SWAP_DEADLINE_SECONDS = 300;

export interface BuildSwapInput {
  amountIn: bigint;
  minOut: bigint;
  path: string[];
  /** The wallet (C…) — both the payer of amountIn and the receiver of the output. */
  to: string;
  /** Unix seconds. */
  deadline: bigint;
}

export interface BuiltSwap {
  /** Assembled, simulated transaction — what kit.sign consumes. */
  tx: unknown;
  /** Per-hop amounts the simulation produced; the last one is the output. */
  simulatedAmounts: bigint[];
}

export type SwapOutcome =
  | { status: "success"; amounts: bigint[] }
  | {
      status: "partial";
      amounts: bigint[];
      filledAmountIn?: bigint;
      remainingAmountIn?: bigint;
    }
  | { status: "failed" }
  | { status: "unknown" };

export interface SwapVenue {
  name: string;
  router: string;
  getAmountsOut(amountIn: bigint, path: string[]): Promise<bigint[]>;
  buildSwap(input: BuildSwapInput): Promise<BuiltSwap>;
  readOutcome(hash: string): Promise<SwapOutcome>;
}

const ROUTER_ERRORS: Record<number, string> = {
  503: "The swap's deadline passed before it reached the network.",
  507: "The price moved past your slippage limit, so the swap was refused. Nothing was exchanged.",
  509: "There is no pool for this pair on the venue.",
  510: "Amount is too small for this pool.",
  511: "Not enough liquidity in the pool for that amount.",
  512: "Amount is too small for this pool.",
  513: "Not enough liquidity in the pool for that amount.",
  514: "The venue rejected the route.",
};

export class SwapVenueError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.name = "SwapVenueError";
    this.code = code;
  }
}

/** Map a simulation / submission failure to a venue error, keeping the router code. */
export function toVenueError(err: unknown): SwapVenueError {
  const text = err instanceof Error ? err.message : String(err);
  const match = /Error\(Contract, #(\d+)\)/.exec(text);
  const code = match ? Number(match[1]) : null;
  const known = code !== null ? ROUTER_ERRORS[code] : undefined;
  return new SwapVenueError(known ?? "The swap venue couldn't process this swap.", code);
}

function toBigints(value: unknown): bigint[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "bigint")) {
    throw new SwapVenueError("The swap venue returned an unexpected response.", null);
  }
  return value as bigint[];
}

export function createSoroswapVenue(config: {
  network: Network;
  rpcUrl: string;
  networkPassphrase: string;
  /**
   * Transaction source for simulation. Omit for the smart-wallet path: the
   * sponsor re-envelopes the signed transaction, so the null account is used
   * (a contract cannot source an envelope).
   */
  simulationSource?: string;
}): SwapVenue {
  const router = SOROSWAP_ROUTER[config.network];
  const sdk = () => import("@stellar/stellar-sdk");

  async function build(method: string, args: unknown[]) {
    const { contract, scValToNative } = await sdk();
    try {
      return await contract.AssembledTransaction.build({
        contractId: router,
        method,
        args,
        networkPassphrase: config.networkPassphrase,
        rpcUrl: config.rpcUrl,
        ...(config.simulationSource && { publicKey: config.simulationSource }),
        parseResultXdr: (v) => toBigints(scValToNative(v)),
      });
    } catch (err) {
      throw toVenueError(err);
    }
  }

  // A failed simulation does not reject build(); it surfaces when the result
  // is read. Read it here so router errors (#507 …) map like any other.
  function resultOf(tx: { result: bigint[] }): bigint[] {
    try {
      return tx.result;
    } catch (err) {
      throw toVenueError(err);
    }
  }

  async function pathArg(path: string[]) {
    const { Address, xdr } = await sdk();
    return xdr.ScVal.scvVec(path.map((id) => new Address(id).toScVal()));
  }

  return {
    name: "Soroswap",
    router,

    async getAmountsOut(amountIn, path) {
      const { nativeToScVal } = await sdk();
      const tx = await build("router_get_amounts_out", [
        nativeToScVal(amountIn, { type: "i128" }),
        await pathArg(path),
      ]);
      return resultOf(tx);
    },

    async buildSwap({ amountIn, minOut, path, to, deadline }) {
      const { Address, nativeToScVal } = await sdk();
      const tx = await build("swap_exact_tokens_for_tokens", [
        nativeToScVal(amountIn, { type: "i128" }),
        nativeToScVal(minOut, { type: "i128" }),
        await pathArg(path),
        new Address(to).toScVal(),
        nativeToScVal(deadline, { type: "u64" }),
      ]);
      return { tx, simulatedAmounts: resultOf(tx) };
    },

    async readOutcome(hash) {
      const { rpc, scValToNative } = await sdk();
      const server = new rpc.Server(config.rpcUrl);
      const res = await server.getTransaction(hash);
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return res.returnValue
          ? { status: "success", amounts: toBigints(scValToNative(res.returnValue)) }
          : { status: "unknown" };
      }
      if (res.status === rpc.Api.GetTransactionStatus.FAILED) return { status: "failed" };
      return { status: "unknown" };
    },
  };
}
