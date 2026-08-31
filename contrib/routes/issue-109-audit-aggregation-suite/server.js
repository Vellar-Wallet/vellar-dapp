const http = require('http');
const url = require('url');

const PORT = 3109;

// Mock audit log dataset
const logs = [
  { id: 1, actor: "alice", action: "login", timestamp: "2026-08-31T10:00:00Z" },
  { id: 2, actor: "bob", action: "transfer", timestamp: "2026-08-31T10:05:00Z" },
  { id: 3, actor: "alice", action: "transfer", timestamp: "2026-08-31T10:10:00Z" },
  { id: 4, actor: "charlie", action: "logout", timestamp: "2026-08-31T10:15:00Z" },
  { id: 5, actor: "alice", action: "login", timestamp: "2026-08-31T10:20:00Z" },
  { id: 6, actor: "bob", action: "login", timestamp: "2026-08-31T10:25:00Z" },
  { id: 7, actor: "alice", action: "transfer", timestamp: "2026-08-31T10:30:00Z" }
];

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/entries' && req.method === 'GET') {
    const { actor, action, page = 1, limit = 2 } = parsedUrl.query;
    
    let filtered = logs;
    if (actor) filtered = filtered.filter(l => l.actor === actor);
    if (action) filtered = filtered.filter(l => l.action === action);

    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const paginated = filtered.slice(startIndex, startIndex + parseInt(limit));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      total: filtered.length,
      page: parseInt(page),
      limit: parseInt(limit),
      entries: paginated
    }));
  } else if (parsedUrl.pathname === '/summary' && req.method === 'GET') {
    const summary = logs.reduce((acc, log) => {
      acc[log.action] = (acc[log.action] || 0) + 1;
      return acc;
    }, {});
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ summary }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Audit aggregation server running on port ${PORT}`);
});
