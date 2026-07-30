const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

/**
 * =============================================================================
 *  Mock Data Store & Business Logic
 * =============================================================================
 */

const PAIRING_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
};

const SESSION_STATUS = {
  ACTIVE: "active",
  REVOKED: "revoked",
};

// In-memory stores for pairing requests and active sessions.
const pairingRequests = new Map(); // <deviceId, { publicKey, status }>
const sessions = new Map(); // <sessionId, { deviceId, status }>

const app = express();
app.use(bodyParser.json());

/**
 * POST /request-pairing
 * A device sends its public key to request pairing.
 */
app.post("/request-pairing", (req, res) => {
  const { publicKey } = req.body;
  if (!publicKey) {
    return res.status(400).json({ error: "publicKey is required" });
  }

  const deviceId = `device-${crypto.randomBytes(8).toString("hex")}`;
  pairingRequests.set(deviceId, { publicKey, status: PAIRING_STATUS.PENDING });

  console.log(`[Server] Pairing request received for device ${deviceId}`);
  res.status(202).json({ deviceId });
});

/**
 * POST /approve-pairing/:deviceId
 * A user approves a pending pairing request.
 */
app.post("/approve-pairing/:deviceId", (req, res) => {
  const { deviceId } = req.params;
  const request = pairingRequests.get(deviceId);

  if (!request || request.status !== PAIRING_STATUS.PENDING) {
    return res.status(404).json({ error: "Pending pairing request not found" });
  }

  request.status = PAIRING_STATUS.APPROVED;
  console.log(`[Server] Pairing request for device ${deviceId} approved`);
  res.status(200).json({ message: "Pairing approved successfully" });
});

/**
 * POST /issue-session
 * An approved device requests a session token.
 */
app.post("/issue-session", (req, res) => {
  const { deviceId, publicKey } = req.body;
  const request = pairingRequests.get(deviceId);

  if (!request || request.publicKey !== publicKey) {
    return res.status(403).json({ error: "Invalid deviceId or publicKey" });
  }

  if (request.status !== PAIRING_STATUS.APPROVED) {
    return res.status(403).json({ error: "Pairing not approved" });
  }

  const sessionId = `session-${crypto.randomBytes(16).toString("hex")}`;
  sessions.set(sessionId, { deviceId, status: SESSION_STATUS.ACTIVE });

  console.log(`[Server] Session ${sessionId} issued for device ${deviceId}`);
  res.status(201).json({ sessionId });
});

/**
 * GET /session-status/:sessionId
 * Checks the status of a session.
 */
app.get("/session-status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  console.log(`[Server] Status check for session ${sessionId}: ${session.status}`);
  res.status(200).json({ status: session.status });
});

/**
 * POST /revoke-session
 * Invalidates an active session.
 */
app.post("/revoke-session", (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  session.status = SESSION_STATUS.REVOKED;
  console.log(`[Server] Session ${sessionId} has been revoked`);
  res.status(200).json({ message: "Session revoked successfully" });
});

const PORT = 4501;
app.listen(PORT, () => {
  console.log(`Device pairing simulation server running on http://localhost:${PORT}`);
  console.log("Run `node test.js` in another terminal to test the endpoints.");
});