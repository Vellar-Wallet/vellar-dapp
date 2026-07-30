import { app, __resetSponsorForTest } from "./index";

async function testFeeSponsorship(): Promise<void> {
  console.log("Testing fee sponsorship...\n");

  __resetSponsorForTest();

  // Start server in background
  const port = 3003;
  await app.listen({ port, host: "127.0.0.1" });

  try {
    // Check initial balance
    console.log("Initial sponsor balance:");
    const balanceResponse1 = await fetch(`http://127.0.0.1:${port}/sponsor-balance`);
    const balance1 = (await balanceResponse1.json()) as {
      balance: number;
      initialBalance: number;
      totalFeesDeducted: number;
    };
    console.log(`  Balance: ${balance1.balance}`);
    console.log(`  Initial: ${balance1.initialBalance}`);
    console.log(`  Total Fees Deducted: ${balance1.totalFeesDeducted}\n`);

    // Submit first transaction
    console.log("Submitting transaction 1 (fee: 200):");
    const submit1 = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: "tx1", fee: 200 }),
    });
    const result1 = (await submit1.json()) as {
      transactionId: string;
      feeDeducted: number;
      remainingBalance: number;
      status: string;
    };
    console.log(`  Status: ${result1.status}`);
    console.log(`  Fee Deducted: ${result1.feeDeducted}`);
    console.log(`  Remaining Balance: ${result1.remainingBalance}\n`);

    if (result1.status !== "accepted") {
      console.log("✗ Test failed: First submission should be accepted");
      return;
    }

    // Submit second transaction
    console.log("Submitting transaction 2 (fee: 300):");
    const submit2 = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: "tx2", fee: 300 }),
    });
    const result2 = (await submit2.json()) as {
      transactionId: string;
      feeDeducted: number;
      remainingBalance: number;
      status: string;
    };
    console.log(`  Status: ${result2.status}`);
    console.log(`  Fee Deducted: ${result2.feeDeducted}`);
    console.log(`  Remaining Balance: ${result2.remainingBalance}\n`);

    if (result2.status !== "accepted") {
      console.log("✗ Test failed: Second submission should be accepted");
      return;
    }

    // Submit third transaction
    console.log("Submitting transaction 3 (fee: 400):");
    const submit3 = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: "tx3", fee: 400 }),
    });
    const result3 = (await submit3.json()) as {
      transactionId: string;
      feeDeducted: number;
      remainingBalance: number;
      status: string;
    };
    console.log(`  Status: ${result3.status}`);
    console.log(`  Fee Deducted: ${result3.feeDeducted}`);
    console.log(`  Remaining Balance: ${result3.remainingBalance}\n`);

    if (result3.status !== "accepted") {
      console.log("✗ Test failed: Third submission should be accepted");
      return;
    }

    // Check balance after successful submissions
    console.log("Balance after 3 successful submissions:");
    const balanceResponse2 = await fetch(`http://127.0.0.1:${port}/sponsor-balance`);
    const balance2 = (await balanceResponse2.json()) as {
      balance: number;
      initialBalance: number;
      totalFeesDeducted: number;
    };
    console.log(`  Balance: ${balance2.balance}`);
    console.log(`  Total Fees Deducted: ${balance2.totalFeesDeducted}\n`);

    if (balance2.balance !== 100) {
      console.log("✗ Test failed: Expected balance of 100 after 900 in fees");
      return;
    }

    // Attempt submission that should fail due to insufficient balance
    console.log("Submitting transaction 4 (fee: 200) - should fail:");
    const submit4 = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: "tx4", fee: 200 }),
    });
    const result4 = (await submit4.json()) as {
      error: string;
      transactionId: string;
      requiredFee: number;
      currentBalance: number;
    };
    console.log(`  Error: ${result4.error}`);
    console.log(`  Required Fee: ${result4.requiredFee}`);
    console.log(`  Current Balance: ${result4.currentBalance}\n`);

    if (!result4.error || result4.error !== "Insufficient sponsor balance") {
      console.log("✗ Test failed: Fourth submission should be rejected");
      return;
    }

    // Verify balance hasn't changed after failed submission
    console.log("Balance after failed submission:");
    const balanceResponse3 = await fetch(`http://127.0.0.1:${port}/sponsor-balance`);
    const balance3 = (await balanceResponse3.json()) as {
      balance: number;
      initialBalance: number;
      totalFeesDeducted: number;
    };
    console.log(`  Balance: ${balance3.balance}`);
    console.log(`  Total Fees Deducted: ${balance3.totalFeesDeducted}\n`);

    if (balance3.balance !== 100) {
      console.log("✗ Test failed: Balance should not change after failed submission");
      return;
    }

    console.log("✓ All tests passed!");
  } finally {
    await app.close();
  }
}

testFeeSponsorship().catch(console.error);
