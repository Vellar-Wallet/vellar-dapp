import { app, __resetCacheForTest } from "./index";

async function testVerificationCache(): Promise<void> {
  console.log("Testing verification cache...\n");

  __resetCacheForTest();

  // Start server in background
  const port = 3002;
  await app.listen({ port, host: "127.0.0.1" });

  try {
    const contractId = "0x1234567890abcdef";

    // First lookup - should be a cache miss
    console.log("First lookup (should be cache miss):");
    const response1 = await fetch(`http://127.0.0.1:${port}/lookup?id=${contractId}`);
    const data1 = (await response1.json()) as {
      id: string;
      verified: boolean;
      sourceCode: string;
      cacheHit: boolean;
    };
    console.log(`  ID: ${data1.id}`);
    console.log(`  Verified: ${data1.verified}`);
    console.log(`  Cache Hit: ${data1.cacheHit}`);

    if (data1.cacheHit !== false) {
      console.log("✗ Test failed: First lookup should have cacheHit=false");
      return;
    }
    console.log("✓ First lookup correctly reports cache miss\n");

    // Second lookup - should be a cache hit
    console.log("Second lookup (should be cache hit):");
    const response2 = await fetch(`http://127.0.0.1:${port}/lookup?id=${contractId}`);
    const data2 = (await response2.json()) as {
      id: string;
      verified: boolean;
      sourceCode: string;
      cacheHit: boolean;
    };
    console.log(`  ID: ${data2.id}`);
    console.log(`  Verified: ${data2.verified}`);
    console.log(`  Cache Hit: ${data2.cacheHit}`);

    if (data2.cacheHit !== true) {
      console.log("✗ Test failed: Second lookup should have cacheHit=true");
      return;
    }
    console.log("✓ Second lookup correctly reports cache hit\n");

    // Third lookup - another cache hit
    console.log("Third lookup (should be cache hit):");
    const response3 = await fetch(`http://127.0.0.1:${port}/lookup?id=${contractId}`);
    const data3 = (await response3.json()) as {
      id: string;
      verified: boolean;
      sourceCode: string;
      cacheHit: boolean;
    };
    console.log(`  ID: ${data3.id}`);
    console.log(`  Verified: ${data3.verified}`);
    console.log(`  Cache Hit: ${data3.cacheHit}`);

    if (data3.cacheHit !== true) {
      console.log("✗ Test failed: Third lookup should have cacheHit=true");
      return;
    }
    console.log("✓ Third lookup correctly reports cache hit\n");

    // Check cache stats
    console.log("Cache stats:");
    const statsResponse = await fetch(`http://127.0.0.1:${port}/cache-stats`);
    const stats = (await statsResponse.json()) as {
      totalLookups: number;
      totalCacheHits: number;
      hitRate: number;
    };
    console.log(`  Total Lookups: ${stats.totalLookups}`);
    console.log(`  Total Cache Hits: ${stats.totalCacheHits}`);
    console.log(`  Hit Rate: ${stats.hitRate.toFixed(2)}`);

    if (stats.totalLookups !== 3) {
      console.log("✗ Test failed: Expected 3 total lookups");
      return;
    }
    if (stats.totalCacheHits !== 2) {
      console.log("✗ Test failed: Expected 2 total cache hits");
      return;
    }
    if (Math.abs(stats.hitRate - 2/3) > 0.01) {
      console.log("✗ Test failed: Hit rate should be 0.67");
      return;
    }
    console.log("✓ Cache stats are correct\n");

    console.log("✓ All tests passed!");
  } finally {
    await app.close();
  }
}

testVerificationCache().catch(console.error);
