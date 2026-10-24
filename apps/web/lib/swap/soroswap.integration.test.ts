// @vitest-environment node

import {
  Asset,
  contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { assetsFor, findAssetByContractId, type RegisteredAsset } from "@/lib/assets";
import { createSwapClient } from "./client";
import { minimumOut } from "./quote";
import { createSoroswapVenue, SwapVenueError } from "./soroswap";

// Live testnet integration against the real Soroswap router. Opt-in (network
// + friendbot): STELLAR_TESTNET_INTEGRATION=1 pnpm --filter @vellar/web test.
//
// Proves, against the deployed contracts rather than a mock:
//   - quotes come from the venue (router_get_amounts_out)
//   - a swap whose floor is above what the pool gives is REFUSED by the
//     router (#507) — it does not execute at the worse rate
//   - a swap within the floor executes on-chain and pays at least the floor
// The smart-wallet signing leg (passkey) is covered by the mocked client
// tests; here a friendbot G-account is the swapper so the router path can be
// executed headlessly.

const RPC = "https://soroban-testnet.stellar.org";
const [XLM, USDC] = assetsFor("testnet") as [RegisteredAsset, RegisteredAsset];
const resolve = (id: string) => findAssetByContractId("testnet", id);

describe.skipIf(!process.env.STELLAR_TESTNET_INTEGRATION)("Soroswap on testnet", () => {
  const swapper = Keypair.random();
  const venue = createSoroswapVenue({
    network: "testnet",
    rpcUrl: RPC,
    networkPassphrase: Networks.TESTNET,
    simulationSource: swapper.publicKey(),
  });

  beforeAll(async () => {
    const res = await fetch(`https://friendbot.stellar.org/?addr=${swapper.publicKey()}`);
    expect(res.ok).toBe(true);
    // A classic G-account needs a USDC trustline to receive the swap output.
    // (A smart-wallet C-address does not: SAC balances need no trustline.)
    const server = new rpc.Server(RPC);
    const account = await server.getAccount(swapper.publicKey());
    const trust = new TransactionBuilder(account, {
      fee: "1000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: new Asset(USDC.code, USDC.issuer) }))
      .setTimeout(60)
      .build();
    trust.sign(swapper);
    const sent = await server.sendTransaction(trust);
    expect(sent.status).toBe("PENDING");
    const final = await server.pollTransaction(sent.hash, { attempts: 20 });
    expect(final.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
  }, 90_000);

  it("quotes XLM -> USDC from the router", async () => {
    const amounts = await venue.getAmountsOut(10_000_000n, [XLM.contractId, USDC.contractId]);
    expect(amounts).toHaveLength(2);
    expect(amounts[0]).toBe(10_000_000n);
    expect(amounts[1]).toBeGreaterThan(0n);
  }, 60_000);

  it("refuses a swap whose floor exceeds what the pool pays (#507)", async () => {
    const [, expected] = await venue.getAmountsOut(10_000_000n, [XLM.contractId, USDC.contractId]);
    const err = await venue
      .buildSwap({
        amountIn: 10_000_000n,
        minOut: (expected as bigint) + 1n,
        slippageBps: 100,
        path: [XLM.contractId, USDC.contractId],
        to: swapper.publicKey(),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwapVenueError);
    expect((err as SwapVenueError).code).toBe(507);
  }, 60_000);

  it("executes a swap within the floor and receives at least the minimum", async () => {
    const swaps = createSwapClient({
      venue,
      kit: { sign: async (tx) => tx },
      backend: { submitTransaction: async () => ({ hash: "" }) },
      network: "testnet",
      signedToXdr: () => "",
    });
    const quote = await swaps.quote({ sell: XLM, buy: USDC, amountIn: 10_000_000n, resolve });
    const minOut = minimumOut(quote.expectedOut, 100);
    const built = await venue.buildSwap({
      amountIn: quote.amountIn,
      minOut,
      slippageBps: 100,
      path: quote.path,
      to: swapper.publicKey(),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    });

    const tx = built.tx as contract.AssembledTransaction<bigint[]>;
    const signer = contract.basicNodeSigner(swapper, Networks.TESTNET);
    const sent = await tx.signAndSend({ signTransaction: signer.signTransaction });
    const hash = sent.sendTransactionResponse?.hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const outcome = await venue.readOutcome(hash as string);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      const received = outcome.amounts[outcome.amounts.length - 1] as bigint;
      expect(received).toBeGreaterThanOrEqual(minOut);
      console.info(`testnet swap ${hash}: 1 XLM -> ${received} USDC base units (floor ${minOut})`);
    }
  }, 120_000);
});
