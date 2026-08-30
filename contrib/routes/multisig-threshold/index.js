const http = require('http');

// Dummy database for a sample account
const accountConfig = {
  signers: ['alice', 'bob', 'charlie'],
  threshold: 2
};

const handlers = {
  get: (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      threshold: accountConfig.threshold,
      signerCount: accountConfig.signers.length
    }));
  },
  set: (req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let threshold;
      try {
        const payload = JSON.parse(body);
        threshold = parseInt(payload.threshold, 10);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      
      if (isNaN(threshold) || threshold <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid threshold' }));
        return;
      }

      if (threshold > accountConfig.signers.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Threshold cannot exceed number of signers' }));
        return;
      }

      accountConfig.threshold = threshold;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, threshold }));
    });
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  
  if (parts[0] === 'config' && req.method === 'GET') {
    return handlers.get(req, res);
  }
  if (parts[0] === 'config' && req.method === 'POST') {
    return handlers.set(req, res);
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

module.exports = server;

if (require.main === module) {
  server.listen(3003, () => {
    console.log('Server running on port 3003');
  });
}
