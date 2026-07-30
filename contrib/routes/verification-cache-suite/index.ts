import Fastify, { FastifyRequest, FastifyReply } from "fastify";

const app = Fastify({ logger: false });

// In-memory cache and stats
const cache = new Map<string, VerificationResult>();
let totalLookups = 0;
let totalCacheHits = 0;

interface VerificationResult {
  id: string;
  verified: boolean;
  sourceCode: string;
  compilerVersion: string;
}

// GET /lookup
app.get("/lookup", async (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.query as { id: string };

  if (!id) {
    return reply.status(400).send({ error: "id query parameter is required" });
  }

  totalLookups++;

  const cached = cache.get(id);
  if (cached) {
    totalCacheHits++;
    return {
      ...cached,
      cacheHit: true,
    };
  }

  // Simulate verification lookup (mock data)
  const result: VerificationResult = {
    id,
    verified: true,
    sourceCode: `// Source code for ${id}\npragma solidity ^0.8.0;\ncontract Mock { }`,
    compilerVersion: "0.8.20",
  };

  cache.set(id, result);

  return {
    ...result,
    cacheHit: false,
  };
});

// GET /cache-stats
app.get("/cache-stats", async () => {
  const hitRate = totalLookups > 0 ? totalCacheHits / totalLookups : 0;

  return {
    totalLookups,
    totalCacheHits,
    hitRate,
  };
});

// Reset function for testing
export function __resetCacheForTest(): void {
  cache.clear();
  totalLookups = 0;
  totalCacheHits = 0;
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3002;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Verification cache suite running on port ${port}`);
}

export { app };
