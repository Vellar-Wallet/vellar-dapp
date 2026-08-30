const http = require('http');

// Dummy database of wasm hashes
const db = {
  'contract-1': 'a3f01b3c',
  'contract-2': 'b7d2f9e4'
};

const handlers = {
  lookup: (req, res, id) => {
    const hash = db[id];
    if (!hash) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown contract ID' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, hash }));
  },
  compare: (req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let hash1, hash2;
      try {
        const payload = JSON.parse(body);
        hash1 = payload.hash1;
        hash2 = payload.hash2;
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      
      if (!hash1 || !hash2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing hash1 or hash2' }));
        return;
      }

      const match = hash1 === hash2;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ match }));
    });
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  
  if (parts[0] === 'lookup' && parts[1] && req.method === 'GET') {
    return handlers.lookup(req, res, parts[1]);
  }
  if (parts[0] === 'compare' && req.method === 'POST') {
    return handlers.compare(req, res);
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

module.exports = server;

if (require.main === module) {
  server.listen(3002, () => {
    console.log('Server running on port 3002');
  });
}
