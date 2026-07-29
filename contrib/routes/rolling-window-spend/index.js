const http = require('http');

// In-memory state: accountId -> array of { timestamp, amount }
const spends = new Map();

// Configuration
const LIMIT = 1000;
const WINDOW_MS = 60 * 1000; // 60 seconds rolling window

const handlers = {
  spend: (req, res, accountId) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let amount;
      try {
        const payload = JSON.parse(body);
        amount = parseFloat(payload.amount);
      } catch (e) {
        return sendError(res, 400, 'Invalid JSON');
      }
      if (isNaN(amount) || amount <= 0) {
        return sendError(res, 400, 'Invalid amount');
      }

      const now = Date.now();
      const accountSpends = spends.get(accountId) || [];
      
      // Clean up old spends
      const validSpends = accountSpends.filter(s => now - s.timestamp <= WINDOW_MS);
      const currentTotal = validSpends.reduce((acc, s) => acc + s.amount, 0);

      if (currentTotal + amount > LIMIT) {
        return sendError(res, 429, 'Spend limit exceeded');
      }

      validSpends.push({ timestamp: now, amount });
      spends.set(accountId, validSpends);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, remaining: LIMIT - (currentTotal + amount) }));
    });
  },
  allowance: (req, res, accountId) => {
    const now = Date.now();
    const accountSpends = spends.get(accountId) || [];
    
    // Clean up old spends
    const validSpends = accountSpends.filter(s => now - s.timestamp <= WINDOW_MS);
    spends.set(accountId, validSpends); // update memory
    
    const currentTotal = validSpends.reduce((acc, s) => acc + s.amount, 0);
    const remaining = Math.max(0, LIMIT - currentTotal);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ limit: LIMIT, remaining }));
  }
};

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  
  if (parts[0] === 'spend' && parts[1] && req.method === 'POST') {
    return handlers.spend(req, res, parts[1]);
  }
  if (parts[0] === 'allowance' && parts[1] && req.method === 'GET') {
    return handlers.allowance(req, res, parts[1]);
  }
  
  send404(res);
});

module.exports = server;

if (require.main === module) {
  server.listen(3001, () => {
    console.log('Server running on port 3001');
  });
}
