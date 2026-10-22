const http = require('node:http');

const INITIAL_BALANCE = 100;
const DEFAULT_FEE = 40;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function createServer({ initialBalance = INITIAL_BALANCE } = {}) {
  let sponsorBalance = initialBalance;
  let submissionCount = 0;

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/sponsor-balance') {
      sendJson(response, 200, { sponsorBalance });
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/submit') {
      sendJson(response, 404, { error: 'Route not found' });
      return;
    }

    let payload;
    try {
      payload = await readJson(request);
    } catch {
      sendJson(response, 400, { error: 'Request body must be valid JSON' });
      return;
    }

    const fee = payload.fee ?? DEFAULT_FEE;
    if (typeof fee !== 'number' || !Number.isFinite(fee) || fee <= 0) {
      sendJson(response, 400, { error: 'Fee must be a positive finite number' });
      return;
    }

    if (sponsorBalance - fee < 0) {
      sendJson(response, 409, {
        error: 'Sponsor budget exhausted',
        requestedFee: fee,
        sponsorBalance,
      });
      return;
    }

    sponsorBalance -= fee;
    submissionCount += 1;
    sendJson(response, 201, {
      submissionId: submissionCount,
      fee,
      sponsorBalance,
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3001);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Fee sponsorship suite listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };
