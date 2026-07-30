import Fastify, { FastifyRequest, FastifyReply } from "fastify";

const app = Fastify({ logger: false });

// Fixed exchange rate table (base: USD)
const RATES: Record<string, number> = {
  ETH: 3000,
  USDC: 1,
  USDT: 1,
  BTC: 15000,
  SOL: 150,
  DAI: 1,
};

// In-memory account balances
const accountBalances = new Map<string, Array<{ asset: string; balance: number }>>();

// Initialize sample data
accountBalances.set("user123", [
  { asset: "ETH", balance: 1.5 },
  { asset: "USDC", balance: 1000 },
  { asset: "BTC", balance: 0.05 },
  { asset: "UNKNOWN", balance: 100 },
]);

accountBalances.set("user456", [
  { asset: "SOL", balance: 100 },
  { asset: "DAI", balance: 500 },
  { asset: "USDT", balance: 250 },
]);

interface Balance {
  asset: string;
  balance: number;
}

interface ConvertedBalance {
  asset: string;
  balance: number;
  rate: number;
  convertedValue: number;
}

// GET /raw-balances
app.get("/raw-balances", async (request: FastifyRequest, reply: FastifyReply) => {
  const { accountId } = request.query as { accountId: string };

  if (!accountId) {
    return reply.status(400).send({ error: "accountId query parameter is required" });
  }

  const balances = accountBalances.get(accountId);
  if (!balances) {
    return reply.status(404).send({ error: "Account not found" });
  }

  return {
    accountId,
    balances,
  };
});

// GET /aggregated-value
app.get("/aggregated-value", async (request: FastifyRequest, reply: FastifyReply) => {
  const { accountId, displayAsset = "USD" } = request.query as { accountId: string; displayAsset?: string };

  if (!accountId) {
    return reply.status(400).send({ error: "accountId query parameter is required" });
  }

  const balances = accountBalances.get(accountId);
  if (!balances) {
    return reply.status(404).send({ error: "Account not found" });
  }

  const breakdown: ConvertedBalance[] = [];
  const warnings: string[] = [];
  let aggregatedValue = 0;

  for (const entry of balances) {
    const rate = RATES[entry.asset];

    if (rate === undefined) {
      warnings.push(`Asset ${entry.asset} has no known rate to ${displayAsset} and was excluded`);
      continue;
    }

    const convertedValue = entry.balance * rate;
    aggregatedValue += convertedValue;

    breakdown.push({
      asset: entry.asset,
      balance: entry.balance,
      rate,
      convertedValue,
    });
  }

  return {
    accountId,
    displayAsset,
    aggregatedValue,
    breakdown,
    warnings,
  };
});

// Reset function for testing
export function __resetBalancesForTest(): void {
  accountBalances.clear();
  accountBalances.set("user123", [
    { asset: "ETH", balance: 1.5 },
    { asset: "USDC", balance: 1000 },
    { asset: "BTC", balance: 0.05 },
    { asset: "UNKNOWN", balance: 100 },
  ]);
  accountBalances.set("user456", [
    { asset: "SOL", balance: 100 },
    { asset: "DAI", balance: 500 },
    { asset: "USDT", balance: 250 },
  ]);
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3004;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Cross asset balance suite running on port ${port}`);
}

export { app };
