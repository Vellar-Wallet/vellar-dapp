const express = require('express');
const router = express.Router();

// In-memory storage for spending policies
const policies = [];

router.use(express.json());

router.post('/policies', (req, res) => {
  const { limit, windowSeconds } = req.body;
  
  if (typeof limit !== 'number' || limit <= 0) {
    return res.status(400).json({ error: 'limit must be a positive number' });
  }
  
  if (typeof windowSeconds !== 'number' || windowSeconds <= 0) {
    return res.status(400).json({ error: 'windowSeconds must be a positive number' });
  }
  
  const policy = {
    id: policies.length + 1,
    limit,
    windowSeconds,
    createdAt: new Date().toISOString()
  };
  
  policies.push(policy);
  res.status(201).json(policy);
});

router.get('/policies', (req, res) => {
  res.json({ policies });
});

module.exports = router;
