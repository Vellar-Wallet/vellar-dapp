import Fastify, { FastifyRequest, FastifyReply } from "fastify";

const app = Fastify({ logger: false });

// In-memory storage
const batches = new Map<string, Batch>();
let batchCounter = 0;

interface Transaction {
  id: string;
  data: string;
}

interface BatchItem {
  id: string;
  data: string;
  state: "pending" | "retrying" | "succeeded" | "failed";
  attempts: number;
  shouldFail: boolean;
}

interface Batch {
  id: string;
  items: BatchItem[];
  maxRetries: number;
  createdAt: number;
}

interface EnqueueRequest {
  transactions: Transaction[];
  failureRate?: number;
  maxRetries?: number;
}

// POST /enqueue-batch
app.post("/enqueue-batch", async (request: FastifyRequest, reply: FastifyReply) => {
  const body = request.body as EnqueueRequest;
  const { transactions, failureRate = 0.3, maxRetries = 3 } = body;

  if (!Array.isArray(transactions) || transactions.length === 0) {
    return reply.status(400).send({ error: "transactions must be a non-empty array" });
  }

  batchCounter++;
  const batchId = `batch-${batchCounter}`;

  const items: BatchItem[] = transactions.map((tx) => ({
    id: tx.id,
    data: tx.data,
    state: "pending" as const,
    attempts: 0,
    shouldFail: Math.random() < failureRate,
  }));

  const batch: Batch = {
    id: batchId,
    items,
    maxRetries,
    createdAt: Date.now(),
  };

  batches.set(batchId, batch);

  // Start processing the batch
  processBatch(batch);

  return {
    batchId,
    totalCount: items.length,
    pending: items.length,
  };
});

// GET /batch-status/:batchId
app.get("/batch-status/:batchId", async (request: FastifyRequest, reply: FastifyReply) => {
  const { batchId } = request.params as { batchId: string };

  const batch = batches.get(batchId);
  if (!batch) {
    return reply.status(404).send({ error: "Batch not found" });
  }

  return {
    batchId,
    items: batch.items.map((item) => ({
      id: item.id,
      state: item.state,
      attempts: item.attempts,
    })),
  };
});

async function processBatch(batch: Batch): Promise<void> {
  for (const item of batch.items) {
    await processItem(batch, item);
  }
}

async function processItem(batch: Batch, item: BatchItem): Promise<void> {
  if (item.state === "succeeded" || item.state === "failed") {
    return;
  }

  item.attempts++;
  item.state = "retrying";

  // Simulate processing delay
  await new Promise((resolve) => setTimeout(resolve, 10));

  if (item.shouldFail && item.attempts === 1) {
    // First attempt fails
    item.state = "retrying";
    // Retry after a short delay
    setTimeout(() => processItem(batch, item), 50);
  } else if (item.attempts > batch.maxRetries) {
    // Retries exhausted
    item.state = "failed";
  } else {
    // Success
    item.state = "succeeded";
  }
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3001;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Batch queue suite running on port ${port}`);
}

export { app };
