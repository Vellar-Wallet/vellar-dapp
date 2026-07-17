import {
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// Funds a smart wallet (contract address) on testnet: friendbot funds a fresh
// classic account, which then SAC-transfers XLM to the contract. Classic
// payments can't target C-addresses, so this is the canonical funding path.

const RPC_URL = "https://soroban-testnet.stellar.org";

export async function fundSmartWallet(contractId: string, xlm: bigint): Promise<Keypair> {
  const server = new rpc.Server(RPC_URL);

  const funder = Keypair.random();
  const fb = await fetch(`https://friendbot.stellar.org?addr=${funder.publicKey()}`);
  if (!fb.ok) throw new Error(`friendbot failed: ${fb.status}`);

  const account = await server.getAccount(funder.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: (Number(BASE_FEE) * 1000).toString(),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: Asset.native().contractId(Networks.TESTNET),
        function: "transfer",
        args: [
          new Address(funder.publicKey()).toScVal(),
          new Address(contractId).toScVal(),
          nativeToScVal(xlm * 10_000_000n, { type: "i128" }),
        ],
      }),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(funder);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`funding submit failed: ${sent.hash}`);

  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await server.getTransaction(sent.hash);
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) return funder;
    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`funding tx failed: ${sent.hash}`);
    }
    if (Date.now() > deadline) throw new Error(`funding tx timed out: ${sent.hash}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
