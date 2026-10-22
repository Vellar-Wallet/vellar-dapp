const http = require('node:http');

const DISPLAY_ASSET = 'USD';
const RATES_TO_USD = Object.freeze({
  XLM: 0.12,
  USDC: 1,
  EURC: 1.08,
});
const SAMPLE_ACCOUNTS = Object.freeze({
  'demo-account': Object.freeze([
    Object.freeze({ asset: 'XLM', balance: 100 }),
    Object.freeze({ asset: 'USDC', balance: 25 }),
    Object.freeze({ asset: 'MYSTERY', balance: 7 }),
  ]),
});

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const account = url.searchParams.get('account');
    const balances = SAMPLE_ACCOUNTS[account];

    if (url.pathname !== '/raw-balances' && url.pathname !== '/aggregated-value') {
      sendJson(response, 404, { error: 'Route not found' });
      return;
    }

    if (!balances) {
      sendJson(response, 404, { error: `Unknown account: ${account ?? ''}` });
      return;
    }

    if (url.pathname === '/raw-balances') {
      sendJson(response, 200, { account, balances });
      return;
    }

    const warnings = [];
    const conversions = [];
    let total = 0;

    for (const { asset, balance } of balances) {
      const rate = RATES_TO_USD[asset];
      if (rate === undefined) {
        warnings.push({ asset, message: 'No conversion rate; asset excluded from total' });
        continue;
      }

      const convertedValue = balance * rate;
      total += convertedValue;
      conversions.push({ asset, balance, rate, convertedValue });
    }

    sendJson(response, 200, {
      account,
      displayAsset: DISPLAY_ASSET,
      total,
      conversions,
      warnings,
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Cross-asset balance suite listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };
