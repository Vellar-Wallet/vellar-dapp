const http = require('http');
const crypto = require('crypto');

const payments = new Map();

const handlers = {
  build: (req, res) => {
    const id = crypto.randomUUID();
    payments.set(id, { id, status: 'built', polls: 0 });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, status: 'built' }));
  },
  review: (req, res, id) => {
    const payment = payments.get(id);
    if (!payment) return send404(res);
    payment.status = 'reviewed';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payment));
  },
  submit: (req, res, id) => {
    const payment = payments.get(id);
    if (!payment) return send404(res);
    payment.status = 'pending';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payment));
  },
  status: (req, res, id) => {
    const payment = payments.get(id);
    if (!payment) return send404(res);
    if (payment.status === 'pending') {
      payment.polls += 1;
      if (payment.polls >= 3) {
        payment.status = 'settled';
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payment));
  }
};

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  
  if (parts[0] === 'build' && req.method === 'POST') {
    return handlers.build(req, res);
  }
  if (parts[0] === 'review' && parts[1] && req.method === 'POST') {
    return handlers.review(req, res, parts[1]);
  }
  if (parts[0] === 'submit' && parts[1] && req.method === 'POST') {
    return handlers.submit(req, res, parts[1]);
  }
  if (parts[0] === 'status' && parts[1] && req.method === 'GET') {
    return handlers.status(req, res, parts[1]);
  }
  
  send404(res);
});

module.exports = server;

if (require.main === module) {
  server.listen(3000, () => {
    console.log('Server running on port 3000');
  });
}
