const express = require('express');
const router = express.Router();

// In-memory storage for granted origins
const grantedOrigins = {};

router.use(express.json());

router.post('/grant', (req, res) => {
  const { origin } = req.body;
  if (!origin) {
    return res.status(400).json({ error: 'origin is required' });
  }

  grantedOrigins[origin] = {
    origin,
    grantedAt: new Date().toISOString()
  };

  res.status(201).json(grantedOrigins[origin]);
});

router.post('/revoke', (req, res) => {
  const { origin } = req.body;
  if (!origin) {
    return res.status(400).json({ error: 'origin is required' });
  }

  if (!grantedOrigins[origin]) {
    return res.status(404).json({ error: 'No active grant found for origin' });
  }

  delete grantedOrigins[origin];
  res.status(200).json({ message: 'Origin permission revoked successfully' });
});

module.exports = router;
