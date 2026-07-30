import { app } from "./index";

async function testBatchWithRetries(): Promise<void> {
  console.log("Testing batch queue with retries...\n");

  // Start server in background
  const port = 3001;
  const server = await app.listen({ port, host: "127.0.0.1" });

  try {
    // Enqueue a batch with 5 transactions
    const enqueueResponse = await fetch(`http://127.0.0.1:${port}/enqueue-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactions: [
          { id: "tx1", data: "transaction 1" },
          { id: "tx2", data: "transaction 2" },
          { id: "tx3", data: "transaction 3" },
          { id: "tx4", data: "transaction 4" },
          { id: "tx5", data: "transaction 5" },
        ],
        failureRate: 0.4, // 40% will fail on first attempt
        maxRetries: 3,
      }),
    });

    const enqueueData = (await enqueueResponse.json()) as { batchId: string; totalCount: number; pending: number };
    console.log("Enqueued batch:", enqueueData);
    console.log(`Batch ID: ${enqueueData.batchId}\n`);

    // Poll for status until all items are done
    let allDone = false;
    let attempts = 0;
    const maxAttempts = 20;

    while (!allDone && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 100));

      const statusResponse = await fetch(`http://127.0.0.1:${port}/batch-status/${enqueueData.batchId}`);
      const statusData = (await statusResponse.json()) as {
        batchId: string;
        items: Array<{ id: string; state: string; attempts: number }>;
      };

      console.log(`Status check ${attempts + 1}:`);
      statusData.items.forEach((item) => {
        console.log(`  ${item.id}: ${item.state} (attempts: ${item.attempts})`);
      });

      allDone = statusData.items.every((item) => item.state === "succeeded" || item.state === "failed");
      attempts++;
    }

    console.log("\nFinal status:");
    const finalResponse = await fetch(`http://127.0.0.1:${port}/batch-status/${enqueueData.batchId}`);
    const finalData = (await finalResponse.json()) as {
      batchId: string;
      items: Array<{ id: string; state: string; attempts: number }>;
    };

    finalData.items.forEach((item) => {
      console.log(`  ${item.id}: ${item.state} (attempts: ${item.attempts})`);
    });

    const succeeded = finalData.items.filter((i) => i.state === "succeeded").length;
    const failed = finalData.items.filter((i) => i.state === "failed").length;
    console.log(`\nSummary: ${succeeded} succeeded, ${failed} failed`);

    if (allDone) {
      console.log("✓ Test passed: All items completed");
    } else {
      console.log("✗ Test failed: Items did not complete in time");
    }
  } finally {
    await app.close();
  }
}

testBatchWithRetries().catch(console.error);
