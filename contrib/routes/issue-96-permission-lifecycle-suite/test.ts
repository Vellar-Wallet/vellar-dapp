// contrib/routes/issue-96-permission-lifecycle-suite/test.ts

import { requestHandler, grantHandler, checkHandler } from './handlers';

// Helper to simulate a basic Express-like Response object
const createMockResponse = () => {
    const res: any = {};
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (data: any) => { res.data = data; return res; };
    return res;
};



async function runSimulation() {
    const origin = 'https://dapp.vellar.io';
    const baseTimeMs = 1700000000000; // Arbitrary simulated starting epoch

    console.log("--- 1. Origin Requests Permission ---");
    const reqRes = requestHandler({ origin }, createMockResponse());
    console.log(reqRes.data);

    console.log("\n--- 2. User Grants Permission (10s expiry) ---");
    const grantRes = grantHandler({ origin, expirySeconds: 10 }, createMockResponse(), baseTimeMs);
    console.log(grantRes.data);

    console.log("\n--- 3. System Checks Active Permission (+5 seconds) ---");
    const activeTimeMs = baseTimeMs + 5000; // 5 seconds later
    const activeCheckRes = checkHandler({ origin }, createMockResponse(), activeTimeMs);
    console.assert(activeCheckRes.data.expired === false, "Test Failed: Should be active");
    console.log(activeCheckRes.data);

    console.log("\n--- 4. System Checks Expired Permission (+15 seconds) ---");
    const expiredTimeMs = baseTimeMs + 15000; // 15 seconds later (past the 10s expiry)
    const expiredCheckRes = checkHandler({ origin }, createMockResponse(), expiredTimeMs);
    console.assert(expiredCheckRes.data.expired === true, "Test Failed: Should be expired");
    console.log(expiredCheckRes.data);
}

runSimulation();
