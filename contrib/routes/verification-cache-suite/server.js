const http = require('node:http');

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function createServer() {
  const cache = new Map();
  let totalLookups = 0;
  let totalCacheHits = 0;

  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/cache-stats') {
      sendJson(response, 200, { totalLookups, totalCacheHits });
      return;
    }

    if (request.method !== 'GET' || url.pathname !== '/lookup') {
      sendJson(response, 404, { error: 'Route not found' });
      return;
    }

    const id = url.searchParams.get('id');
    if (!id) {
      sendJson(response, 400, { error: 'Query parameter "id" is required' });
      return;
    }

    totalLookups += 1;
    const cachedResult = cache.get(id);
    if (cachedResult) {
      totalCacheHits += 1;
      sendJson(response, 200, { ...cachedResult, cacheHit: true });
      return;
    }

    const result = { id, verified: true, source: 'sample-registry' };
    cache.set(id, result);
    sendJson(response, 200, { ...result, cacheHit: false });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3002);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Verification cache suite listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };
