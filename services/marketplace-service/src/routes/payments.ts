import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FacilitatorApi } from "../lib/facilitator";
import { FacilitatorError } from "../lib/errors";
import { verifySignedBy } from "../lib/signature";

// Payment routes (new-build-technical-doc.md §4.5).

const quoteBodySchema = z.object({
  resourceUrl: z.url(),
  walletAddress: z.string().min(1),
});

const payBodySchema = z.object({
  resourceUrl: z.url(),
  signedXdr: z.string().min(1),
  walletAddress: z.string().min(1),
  maxAmount: z.string().regex(/^\d+$/, "maxAmount must be base units as a decimal string"),
});

/** The x402 challenge fields we surface to the client. Kept permissive: the
 * challenge is authored by the seller's resource, not by us. */
const challengeSchema = z.looseObject({
  accepts: z.array(z.looseObject({})).optional(),
  x402Version: z.number().optional(),
});

export interface PaymentRouteDeps {
  facilitator: FacilitatorApi;
  networkPassphrase: string;
  /** Test seam: how the service fetches the seller's resource URL directly
   * (the 402 challenge does not come from the facilitator). */
  fetchImpl?: typeof fetch;
  /** Timeout for the direct resource fetch. */
  resourceTimeoutMs?: number;
}

export function registerPaymentRoutes(app: FastifyInstance, deps: PaymentRouteDeps): void {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.resourceTimeoutMs ?? 15_000;

  app.post("/marketplace/payments/quote", async (request, reply) => {
    const parsed = quoteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { resourceUrl } = parsed.data;

    // Read-only: this fetches the challenge, it never signs or submits (§4.5).
    let response: Response;
    try {
      response = await doFetch(resourceUrl, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new FacilitatorError(0, `Could not reach the resource: ${reason}`, 502);
    }

    if (response.status === 402) {
      const body = await response.json().catch(() => ({}));
      const challenge = challengeSchema.safeParse(body);
      const accepts = challenge.success ? (challenge.data.accepts ?? []) : [];
      const first = (accepts[0] ?? {}) as Record<string, unknown>;
      return reply.send({
        free: false,
        // §14 Q5: the live 402 challenge is the authoritative price at payment
        // time — the catalog's listed price is only indicative.
        price: first.maxAmountRequired ?? first.amount ?? first.price ?? null,
        asset: first.asset ?? null,
        scheme: first.scheme ?? null,
        network: first.network ?? null,
        payTo: first.payTo ?? null,
        // Vellar sponsors the network fee so buyers need no XLM (§5 "Fees are
        // sponsored"). Settlement is sponsor-funded on the facilitator side.
        areFeesSponsored: true,
        challenge: challenge.success ? challenge.data : body,
      });
    }

    if (response.ok) {
      return reply.send({ free: true, price: null, asset: null, areFeesSponsored: true });
    }

    throw new FacilitatorError(
      response.status,
      `Resource responded ${response.status} to the quote request`,
      502,
    );
  });

  app.post("/marketplace/payments/pay", async (request, reply) => {
    const parsed = payBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { resourceUrl, signedXdr, walletAddress, maxAmount } = parsed.data;

    // Confirm the payer actually signed this envelope before spending an
    // upstream call on it. Throws SignatureError (401) / ValidationError (400).
    verifySignedBy(signedXdr, walletAddress, deps.networkPassphrase);

    // §4.5: verify the authorization, and only then settle. A failure in either
    // surfaces as the FacilitatorError the client should see.
    const verification = await deps.facilitator.verify({
      resourceUrl,
      signedXdr,
      walletAddress,
      maxAmount,
    });

    const isValid = verification.isValid ?? verification.valid ?? true;
    if (isValid === false) {
      const reason =
        typeof verification.invalidReason === "string"
          ? verification.invalidReason
          : "Payment authorization was rejected";
      throw new FacilitatorError(400, reason, 402, "payment_invalid");
    }

    const settlement = await deps.facilitator.settle({
      resourceUrl,
      signedXdr,
      walletAddress,
      maxAmount,
    });

    return reply.send({
      content: settlement.content ?? null,
      txHash: settlement.txHash ?? settlement.transaction ?? settlement.hash ?? null,
      ledger: settlement.ledger ?? null,
      amountPaid: settlement.amountPaid ?? settlement.amount ?? null,
      asset: settlement.asset ?? null,
    });
  });
}
