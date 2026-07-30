const BASE_URL = "http://localhost:4501";

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(endpoint, body) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Request to ${url} failed with status ${res.status}: ${errorText}`);
  }
  return res.json();
}

async function get(endpoint) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Request to ${url} failed with status ${res.status}: ${errorText}`);
  }
  return res.json();
}

async function main() {
  try {
    await fetch(BASE_URL);
  } catch (e) {
    console.error("Error: Could not connect to the server.");
    console.error("Please make sure the server is running with `node server.js` before running this test script.");
    process.exit(1);
  }

  console.log("--- Starting Device Pairing and Session Lifecycle Test ---");

  try {
    // 1. A new device requests to be paired
    console.log("\n1. A new device is requesting to be paired...");
    const devicePublicKey = "pk_test_01h2x3j4k5m6n7p8q9r0s1t2v3";
    const { deviceId } = await post("/request-pairing", { publicKey: devicePublicKey });
    console.log(`   ✅ Success! Received deviceId: ${deviceId}`);

    // 2. Attempt to issue a session BEFORE approval (should fail)
    console.log("\n2. Attempting to issue a session before approval (expected to fail)...");
    try {
      await post("/issue-session", { deviceId, publicKey: devicePublicKey });
      // If this line is reached, the test fails.
      throw new Error("Session was issued without approval, which is incorrect.");
    } catch (error) {
      if (error.message.includes("403") && error.message.includes("Pairing not approved")) {
        console.log("   ✅ Success! Server correctly rejected the unapproved session request.");
      } else {
        // Re-throw if it's an unexpected error
        throw error;
      }
    }

    // 3. A user approves the pairing request
    console.log("\n3. A user is approving the pairing request...");
    await post(`/approve-pairing/${deviceId}`, {});
    console.log(`   ✅ Success! Device ${deviceId} has been approved.`);

    // 4. The approved device requests a session (should succeed now)
    console.log("\n4. The approved device is requesting a session...");
    const { sessionId } = await post("/issue-session", { deviceId, publicKey: devicePublicKey });
    console.log(`   ✅ Success! Received sessionId: ${sessionId}`);

    // 5. Check the status of the new session (should be active)
    console.log("\n5. Verifying the session status...");
    let statusBody = await get(`/session-status/${sessionId}`);
    if (statusBody.status !== "active") {
      throw new Error(`Expected session status to be 'active', but got '${statusBody.status}'`);
    }
    console.log(`   ✅ Success! Session status is '${statusBody.status}'.`);

    // 6. A user revokes the session
    console.log("\n6. A user is revoking the session...");
    await post("/revoke-session", { sessionId });
    console.log(`   ✅ Success! Revocation request sent for session ${sessionId}.`);

    // 7. Check the status again (should be revoked)
    console.log("\n7. Verifying the session status after revocation...");
    statusBody = await get(`/session-status/${sessionId}`);
    if (statusBody.status !== "revoked") {
      throw new Error(`Expected session status to be 'revoked', but got '${statusBody.status}'`);
    }
    console.log(`   ✅ Success! Session status is now '${statusBody.status}'.`);

    console.log("\n--- ✅ All test scenarios passed successfully! ---\n");
  } catch (error) {
    console.error("\n--- ❌ A test scenario failed ---");
    console.error(error.message);
    console.error("-------------------------------------\n");
    process.exit(1);
  }
}

main();