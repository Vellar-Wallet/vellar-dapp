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

test('batch items succeed after the configured first-attempt failures are retried', async (t) => {
  const baseUrl = await startServer(t);
  const enqueueResponse = await fetch(`${baseUrl}/enqueue-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      failFirstAttemptFraction: 0.5,
      items: [{ id: 'tx-1' }, { id: 'tx-2' }, { id: 'tx-3' }, { id: 'tx-4' }],
    }),
  });
  const created = await enqueueResponse.json();

  assert.equal(enqueueResponse.status, 201);
  assert.equal(created.status, 'succeeded');
  assert.deepEqual(created.items.map(({ id }) => id), ['tx-1', 'tx-2', 'tx-3', 'tx-4']);
  assert.deepEqual(created.items.map(({ state }) => state), [
    'succeeded', 'succeeded', 'succeeded', 'succeeded',
  ]);
  assert.deepEqual(created.items.map(({ attempts }) => attempts), [2, 2, 1, 1]);
  assert.deepEqual(created.items[0].stateHistory, ['pending', 'retrying', 'succeeded']);

  const statusResponse = await fetch(`${baseUrl}/batch-status?batchId=${created.batchId}`);
  assert.deepEqual(await statusResponse.json(), created);
});

test('items that keep failing are marked failed after the retry limit', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/enqueue-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ id: 'tx-fail', alwaysFail: true }] }),
  });
  const batch = await response.json();

  assert.equal(batch.items[0].state, 'failed');
  assert.equal(batch.items[0].attempts, 3);
  assert.deepEqual(batch.items[0].stateHistory, [
    'pending', 'retrying', 'retrying', 'failed',
  ]);
});
