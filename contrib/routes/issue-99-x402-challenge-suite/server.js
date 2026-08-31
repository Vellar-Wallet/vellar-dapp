const http = require('http');

const PORT = 3099;

const server = http.createServer((req, res) => {
  if (req.url === '/protected' && req.method === 'GET') {
    const proof = req.headers['x-payment-proof'];
    if (proof === 'valid_mock_proof_123') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: "Protected content accessed!" }));
    } else {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: "Payment Required",
        challenge: {
          amount: 10,
          currency: "CREDITS",
          destination: "mock_wallet_address"
        }
      }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`x402 server running on port ${PORT}`);
});
