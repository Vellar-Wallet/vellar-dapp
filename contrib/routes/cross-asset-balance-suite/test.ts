import { app, __resetBalancesForTest } from "./index";

async function testCrossAssetBalance(): Promise<void> {
  console.log("Testing cross asset balance aggregation...\n");

  __resetBalancesForTest();

  // Start server in background
  const port = 3004;
  await app.listen({ port, host: "127.0.0.1" });

  try {
    const accountId = "user123";

    // Get raw balances
    console.log("Raw balances:");
    const rawResponse = await fetch(`http://127.0.0.1:${port}/raw-balances?accountId=${accountId}`);
    const rawData = (await rawResponse.json()) as {
      accountId: string;
      balances: Array<{ asset: string; balance: number }>;
    };
    console.log(`  Account: ${rawData.accountId}`);
    rawData.balances.forEach((b) => {
      console.log(`    ${b.asset}: ${b.balance}`);
    });
    console.log();

    // Get aggregated value
    console.log("Aggregated value (display asset: USD):");
    const aggResponse = await fetch(`http://127.0.0.1:${port}/aggregated-value?accountId=${accountId}&displayAsset=USD`);
    const aggData = (await aggResponse.json()) as {
      accountId: string;
      displayAsset: string;
      aggregatedValue: number;
      breakdown: Array<{ asset: string; balance: number; rate: number; convertedValue: number }>;
      warnings: string[];
    };
    console.log(`  Account: ${aggData.accountId}`);
    console.log(`  Display Asset: ${aggData.displayAsset}`);
    console.log(`  Aggregated Value: ${aggData.aggregatedValue}`);
    console.log("  Breakdown:");
    aggData.breakdown.forEach((b) => {
      console.log(`    ${b.asset}: ${b.balance} × ${b.rate} = ${b.convertedValue}`);
    });
    console.log("  Warnings:");
    aggData.warnings.forEach((w) => {
      console.log(`    - ${w}`);
    });
    console.log();

    // Verify calculations
    const expectedAggregated = 1.5 * 3000 + 1000 * 1 + 0.05 * 15000; // ETH + USDC + BTC
    console.log(`Expected aggregated value: ${expectedAggregated}`);
    console.log(`Actual aggregated value: ${aggData.aggregatedValue}`);

    if (Math.abs(aggData.aggregatedValue - expectedAggregated) > 0.01) {
      console.log("✗ Test failed: Aggregated value calculation incorrect");
      return;
    }
    console.log("✓ Aggregated value is correct\n");

    // Verify warnings for unknown asset
    if (aggData.warnings.length !== 1 || !aggData.warnings[0].includes("UNKNOWN")) {
      console.log("✗ Test failed: Should have warning for UNKNOWN asset");
      return;
    }
    console.log("✓ Unknown asset correctly excluded with warning\n");

    // Test account with only known assets
    console.log("Testing account with only known assets (user456):");
    const aggResponse2 = await fetch(`http://127.0.0.1:${port}/aggregated-value?accountId=user456&displayAsset=USD`);
    const aggData2 = (await aggResponse2.json()) as {
      accountId: string;
      displayAsset: string;
      aggregatedValue: number;
      breakdown: Array<{ asset: string; balance: number; rate: number; convertedValue: number }>;
      warnings: string[];
    };
    console.log(`  Aggregated Value: ${aggData2.aggregatedValue}`);
    console.log(`  Warnings: ${aggData2.warnings.length}`);

    if (aggData2.warnings.length !== 0) {
      console.log("✗ Test failed: Should have no warnings for known assets");
      return;
    }
    console.log("✓ No warnings for known assets\n");

    console.log("✓ All tests passed!");
  } finally {
    await app.close();
  }
}

testCrossAssetBalance().catch(console.error);
