const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { createServer } = require('./server');

async function startServer(t) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('verification lookups are cached and stats count hits', async (t) => {
  const baseUrl = await startServer(t);

  const firstResponse = await fetch(`${baseUrl}/lookup?id=contract-123`);
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.cacheHit, false);
  assert.equal(first.verified, true);

  const secondResponse = await fetch(`${baseUrl}/lookup?id=contract-123`);
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 200);
  assert.equal(second.cacheHit, true);
  assert.equal(second.verified, true);

  const statsResponse = await fetch(`${baseUrl}/cache-stats`);
  assert.deepEqual(await statsResponse.json(), { totalLookups: 2, totalCacheHits: 1 });
});
