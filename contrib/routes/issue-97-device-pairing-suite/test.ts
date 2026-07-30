// contrib/routes/issue-97-device-pairing-suite/test.ts

import { 
    requestHandler, 
    approveHandler, 
    issueSessionHandler, 
    revokeHandler, 
    statusHandler 
} from './handlers';

// Helper to simulate a basic Express-like Response object
const createMockResponse = () => {
    const res: any = {};
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (data: any) => { res.data = data; return res; };
    return res;
};

async function runDeviceSimulation() {
    const deviceId = 'dev_abc123';
    let activeSessionId = '';

    console.log("--- 1. Device Requests Pairing ---");
    const reqRes = requestHandler({ deviceId }, createMockResponse());
    console.log(reqRes.data);

    console.log("\n--- 2. Attempt Session Issuance (Should Fail - Not Approved) ---");
    const failIssueRes = issueSessionHandler({ deviceId }, createMockResponse());
    console.assert(failIssueRes.statusCode === 403, "Test Failed: Should reject unapproved device");
    console.log(failIssueRes.data);

    console.log("\n--- 3. User Approves Pairing ---");
    const approveRes = approveHandler({ deviceId }, createMockResponse());
    console.log(approveRes.data);

    console.log("\n--- 4. Issue Session (Should Succeed) ---");
    const successIssueRes = issueSessionHandler({ deviceId }, createMockResponse());
    activeSessionId = successIssueRes.data.sessionId;
    console.log(successIssueRes.data);

    console.log("\n--- 5. Check Active Session Status ---");
    const activeStatusRes = statusHandler({ sessionId: activeSessionId }, createMockResponse());
    console.assert(activeStatusRes.data.status === 'active', "Test Failed: Should be active");
    console.log(activeStatusRes.data);

    console.log("\n--- 6. Revoke Session ---");
    const revokeRes = revokeHandler({ sessionId: activeSessionId }, createMockResponse());
    console.log(revokeRes.data);

    console.log("\n--- 7. Check Revoked Session Status ---");
    const revokedStatusRes = statusHandler({ sessionId: activeSessionId }, createMockResponse());
    console.assert(revokedStatusRes.data.status === 'revoked', "Test Failed: Should be revoked");
    console.log(revokedStatusRes.data);
}

runDeviceSimulation();

