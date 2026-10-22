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

test('raw balances and aggregated value exclude unknown-rate assets with a warning', async (t) => {
  const baseUrl = await startServer(t);
  const rawResponse = await fetch(`${baseUrl}/raw-balances?account=demo-account`);
  const raw = await rawResponse.json();

  assert.equal(rawResponse.status, 200);
  assert.deepEqual(raw.balances.map(({ asset }) => asset), ['XLM', 'USDC', 'MYSTERY']);

  const aggregateResponse = await fetch(`${baseUrl}/aggregated-value?account=demo-account`);
  const aggregate = await aggregateResponse.json();

  assert.equal(aggregateResponse.status, 200);
  assert.equal(aggregate.displayAsset, 'USD');
  assert.equal(aggregate.total, 37);
  assert.deepEqual(aggregate.conversions.map(({ asset }) => asset), ['XLM', 'USDC']);
  assert.deepEqual(aggregate.warnings, [
    { asset: 'MYSTERY', message: 'No conversion rate; asset excluded from total' },
  ]);
});
