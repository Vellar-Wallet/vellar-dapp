const express = require('express');
const router = express.Router();

// In-memory store for pairing requests and sessions
const store = {
  pairingRequest: null,
  session: null,
};

// Endpoint to request pairing
router.post('/request', (req, res) => {
  store.pairingRequest = { status: 'pending' };
  res.status(200).json({ message: 'Pairing requested' });
});

// Endpoint to approve pairing
router.post('/approve', (req, res) => {
  if (store.pairingRequest && store.pairingRequest.status === 'pending') {
    store.pairingRequest.status = 'approved';
    res.status(200).json({ message: 'Pairing approved' });
  } else {
    res.status(400).json({ message: 'No pending pairing request to approve' });
  }
});

// Endpoint to issue a session
router.post('/issue-session', (req, res) => {
  if (store.pairingRequest && store.pairingRequest.status === 'approved') {
    store.session = { id: 'session-123', status: 'active' };
    res.status(200).json({ message: 'Session issued', session: store.session });
  } else {
    res.status(400).json({ message: 'Pairing not approved' });
  }
});

// Endpoint to revoke a session
router.post('/revoke', (req, res) => {
  if (store.session && store.session.status === 'active') {
    store.session.status = 'revoked';
    res.status(200).json({ message: 'Session revoked' });
  } else {
    res.status(400).json({ message: 'No active session to revoke' });
  }
});

// Endpoint to check session status
router.get('/status', (req, res) => {
  res.status(200).json({ session: store.session });
});

module.exports = router;
