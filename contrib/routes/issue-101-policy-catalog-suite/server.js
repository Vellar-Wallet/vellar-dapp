const http = require('http');
const url = require('url');

const PORT = 3101;

const policies = {
  "spending_limit": {
    rules: [
      { id: "min_amount", description: "Amount must be at least 10", validate: (config) => config.amount >= 10 },
      { id: "max_amount", description: "Amount must be at most 5000", validate: (config) => config.amount <= 5000 }
    ]
  },
  "time_window": {
    rules: [
      { id: "start_hour", description: "Must start after 08:00", validate: (config) => config.start >= 8 },
      { id: "end_hour", description: "Must end before 18:00", validate: (config) => config.end <= 18 }
    ]
  }
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/list-types' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ types: Object.keys(policies) }));
  } else if (parsedUrl.pathname === '/get-rules' && req.method === 'GET') {
    const type = parsedUrl.query.type;
    if (!type || !policies[type]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: "Policy type not found" }));
    }
    const rules = policies[type].rules.map(r => ({ id: r.id, description: r.description }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type, rules }));
  } else if (parsedUrl.pathname === '/validate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { type, config } = JSON.parse(body);
        if (!type || !policies[type] || !config) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: "Invalid type or config" }));
        }

        const results = policies[type].rules.map(rule => ({
          id: rule.id,
          passed: rule.validate(config)
        }));

        const allPassed = results.every(r => r.passed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type, valid: allPassed, results }));
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
  console.log(`Policy catalog server running on port ${PORT}`);
});
