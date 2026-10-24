const http = require('node:http');

const MAX_RETRIES = 2;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function createServer() {
  const batches = new Map();
  let nextBatchNumber = 1;

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/batch-status') {
      const batchId = url.searchParams.get('batchId');
      const batch = batches.get(batchId);
      if (!batch) {
        sendJson(response, 404, { error: `Unknown batch: ${batchId ?? ''}` });
        return;
      }
      sendJson(response, 200, batch);
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/enqueue-batch') {
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

    const { items, failFirstAttemptFraction = 0.5 } = payload;
    if (!Array.isArray(items) || items.length === 0 || items.some((item) => !item || typeof item.id !== 'string')) {
      sendJson(response, 400, { error: 'items must be a non-empty array of objects with string IDs' });
      return;
    }
    if (typeof failFirstAttemptFraction !== 'number'
      || !Number.isFinite(failFirstAttemptFraction)
      || failFirstAttemptFraction < 0
      || failFirstAttemptFraction > 1) {
      sendJson(response, 400, { error: 'failFirstAttemptFraction must be between 0 and 1' });
      return;
    }

    const firstAttemptFailureCount = Math.ceil(items.length * failFirstAttemptFraction);
    const processedItems = items.map((item, index) => {
      let state = 'pending';
      let attempts = 0;
      const stateHistory = [state];
      const failsFirstAttempt = index < firstAttemptFailureCount;

      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
        attempts += 1;
        const shouldFail = item.alwaysFail === true || (failsFirstAttempt && attempt === 1);
        if (!shouldFail) {
          state = 'succeeded';
          stateHistory.push(state);
          break;
        }

        if (attempt <= MAX_RETRIES) {
          state = 'retrying';
          stateHistory.push(state);
        } else {
          state = 'failed';
          stateHistory.push(state);
        }
      }

      return { id: item.id, state, attempts, stateHistory };
    });

    const batchId = `batch-${nextBatchNumber}`;
    nextBatchNumber += 1;
    const batch = {
      batchId,
      status: processedItems.every(({ state }) => state === 'succeeded')
        ? 'succeeded'
        : 'completed-with-failures',
      items: processedItems,
    };
    batches.set(batchId, batch);
    sendJson(response, 201, batch);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3003);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Batch queue suite listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };
