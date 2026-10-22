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

test('submissions deduct fees and reject spending beyond the sponsor budget', async (t) => {
  const baseUrl = await startServer(t);

  for (let submission = 0; submission < 2; submission += 1) {
    const response = await fetch(`${baseUrl}/submit`, { method: 'POST' });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(result.sponsorBalance, 60 - submission * 40);
  }

  const rejectedResponse = await fetch(`${baseUrl}/submit`, { method: 'POST' });
  const rejected = await rejectedResponse.json();
  assert.equal(rejectedResponse.status, 409);
  assert.equal(rejected.error, 'Sponsor budget exhausted');
  assert.equal(rejected.sponsorBalance, 20);

  const balanceResponse = await fetch(`${baseUrl}/sponsor-balance`);
  assert.deepEqual(await balanceResponse.json(), { sponsorBalance: 20 });
});
