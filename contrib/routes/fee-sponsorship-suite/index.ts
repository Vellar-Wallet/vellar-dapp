import Fastify, { FastifyRequest, FastifyReply } from "fastify";

const app = Fastify({ logger: false });

// In-memory sponsor state
const INITIAL_BALANCE = 1000;
let sponsorBalance = INITIAL_BALANCE;
let totalFeesDeducted = 0;

interface SubmitRequest {
  transactionId: string;
  fee?: number;
}

// POST /submit
app.post("/submit", async (request: FastifyRequest, reply: FastifyReply) => {
  const body = request.body as SubmitRequest;
  const { transactionId, fee = 50 } = body;

  if (!transactionId) {
    return reply.status(400).send({ error: "transactionId is required" });
  }

  if (typeof fee !== "number" || fee <= 0) {
    return reply.status(400).send({ error: "fee must be a positive number" });
  }

  if (sponsorBalance < fee) {
    return reply.status(402).send({
      error: "Insufficient sponsor balance",
      transactionId,
      requiredFee: fee,
      currentBalance: sponsorBalance,
    });
  }

  sponsorBalance -= fee;
  totalFeesDeducted += fee;

  return {
    transactionId,
    feeDeducted: fee,
    remainingBalance: sponsorBalance,
    status: "accepted",
  };
});

// GET /sponsor-balance
app.get("/sponsor-balance", async () => {
  return {
    balance: sponsorBalance,
    initialBalance: INITIAL_BALANCE,
    totalFeesDeducted,
  };
});

// Reset function for testing
export function __resetSponsorForTest(): void {
  sponsorBalance = INITIAL_BALANCE;
  totalFeesDeducted = 0;
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3003;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Fee sponsorship suite running on port ${port}`);
}

export { app };
