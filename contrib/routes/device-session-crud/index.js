const express = require('express');
const router = express.Router();

// Seed the module with at least 3 sample sessions on startup
let deviceSessions = [
  { id: 'session_1', deviceName: 'iPhone 13', lastActive: new Date().toISOString() },
  { id: 'session_2', deviceName: 'MacBook Pro', lastActive: new Date().toISOString() },
  { id: 'session_3', deviceName: 'Windows PC', lastActive: new Date().toISOString() }
];

router.use(express.json());

router.get('/sessions', (req, res) => {
  res.json({ sessions: deviceSessions });
});

router.post('/sessions/:id/revoke', (req, res) => {
  const sessionId = req.params.id;
  const initialLength = deviceSessions.length;
  
  deviceSessions = deviceSessions.filter(session => session.id !== sessionId);
  
  if (deviceSessions.length === initialLength) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.status(200).json({ message: 'Session revoked successfully' });
});

module.exports = router;
