const http = require('http');
const url = require('url');

const PORT = 3100;

// Mock budget state
let budget = 1000;

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/remaining-budget' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ remaining_budget: budget }));
  } else if (parsedUrl.pathname === '/spend' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { amount } = JSON.parse(body);
        if (typeof amount !== 'number' || amount <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: "Invalid amount" }));
        }

        if (amount > budget) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: "Budget exhausted. Spend rejected.", remaining_budget: budget }));
        }

        budget -= amount;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, remaining_budget: budget }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Session budget server running on port ${PORT}`);
});
