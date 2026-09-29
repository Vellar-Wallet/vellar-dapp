import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  registerHealth,
  registerMetrics,
  domainMetrics,
  recordOutcome,
  publicBaseUrlFromEnv,
} from "@vellar/service-kit";
import { buildCleanupSteps, buildMergeStep } from "./builder";
import type { AccountReader } from "./horizon";
import { buildCleanupPlan, isClassicAccountId } from "./planner";
import { paymentMiddleware, x402ResourceServer } from "@x402/fastify";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";

// Lifecycle API (idea.md §11): inspect + plan. Execute/merge land with the
// signing-flow decision (see BUILD-PLAN — docs are ambiguous on who signs
// classic-account cleanup transactions in a passkey wallet).

const inspectBodySchema = z.object({
  accountId: z.string().min(1),
});

const planBodySchema = z.object({
  accountId: z.string().min(1),
  destination: z.string().min(1),
});

export interface LifecycleServiceDeps {
  reader: AccountReader;
  networkPassphrase?: string;
  /** x402 facilitator client for the /lifecycle/execute payment gate. Defaults
   * to a real HTTPFacilitatorClient hitting vellar-facilitator. Tests inject
   * `fakeFacilitatorClient()` instead: x402ResourceServer.initialize() (run on
   * every buildServer() call) otherwise makes a real network call to the live
   * facilitator per test, which is slow and flaky against a cold Render
   * instance — see docs/decisions.md. */
  x402FacilitatorClient?: FacilitatorClient;
}

function capturedSupportedResponse(): SupportedResponse {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "stellar:pubnet",
        extra: { areFeesSponsored: true },
      },
      {
        x402Version: 2,
        scheme: "upto",
        network: "stellar:pubnet",
        extra: {
          uptoContract: "CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN",
          areFeesSponsored: true,
        },
      },
    ],
    extensions: ["bazaar"],
    signers: {
      "stellar:*": [
        "GDEZOW5M5ODU5SMPXC2XQFAHLRQKK7SSYXDZKMAF7ZKPCAX6KFBTFQZS",
        "GDAP7ZVV7B6YSATUMPBQKZPTS4GODE5ZR3BTBTBDNNBXMPGSOA2TLVUS",
        "GAJFQEVBZCKKFBCCFFUMRHB45CB442JO27LNZ7KIQQMK6GKM7G5R5SOL",
        "GAQDNEHYHTNCGJN5HBS7L7NVIV7LM6HIKXNFDAM7ZLLJFNLAT4QVJKAC",
        "GCHPKEKCK7KPWNO2GYGFEGVP2WJQAAOYT6YGDBXHEVF4JCQJXMQTK6KT",
        "GBB7PVDR642MJSALMD3PN4SAPZHUJP555XQMFJJNUH3AN33UQY7FVL3H",
      ],
    },
  };
}

/** A FacilitatorClient that answers getSupported() from a locally-captured
 * snapshot instead of a live network call, so x402ResourceServer.initialize()
 * (invoked by paymentMiddleware on every buildServer() call) doesn't hit the
 * real facilitator in tests. verify()/settle() reject: no test here exercises
 * a real paid request, so a call reaching them signals a test that needs a
 * different seam (e.g. a signed test payment), not this fake. */
export function fakeFacilitatorClient(): FacilitatorClient {
  return {
    async getSupported() {
      return capturedSupportedResponse();
    },
    async verify() {
      throw new Error(
        "fakeFacilitatorClient: verify() is not supported — inject a real client to test payment.",
      );
    },
    async settle() {
      throw new Error(
        "fakeFacilitatorClient: settle() is not supported — inject a real client to test payment.",
      );
    },
  };
}

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function validatePair(accountId: string, destination: string): string | undefined {
  if (!isClassicAccountId(accountId)) return "not_classic_account";
  if (!isClassicAccountId(destination)) return "invalid_destination";
  if (destination === accountId) return "invalid_destination";
  return undefined;
}

export function buildServer(deps: LifecycleServiceDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  registerHealth(app, "lifecycle-service");
  registerMetrics(app, "lifecycle-service");

  app.post("/lifecycle/inspect", async (request, reply) => {
    const parsed = inspectBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId } = parsed.data;
    if (!isClassicAccountId(accountId)) {
      return reply.code(400).send({
        error: "not_classic_account",
        message: "Cleanup applies to classic (G...) accounts; smart wallets cannot be merged",
      });
    }

    const account = await deps.reader.getAccount(accountId);
    if (!account) return reply.code(404).send({ error: "account_not_found" });
    return reply.send({ account });
  });

  app.post("/lifecycle/plan", async (request, reply) => {
    const parsed = planBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId, destination } = parsed.data;
    if (!isClassicAccountId(accountId)) {
      return reply.code(400).send({
        error: "not_classic_account",
        message: "Cleanup applies to classic (G...) accounts; smart wallets cannot be merged",
      });
    }
    if (!isClassicAccountId(destination)) {
      return reply.code(400).send({
        error: "invalid_destination",
        message: "Merge destination must be a classic (G...) account",
      });
    }
    if (destination === accountId) {
      return reply.code(400).send({
        error: "invalid_destination",
        message: "Destination must differ from the account being closed",
      });
    }

    const account = await deps.reader.getAccount(accountId);
    if (!account) return reply.code(404).send({ error: "account_not_found" });
    return reply.send({ plan: buildCleanupPlan(account, destination) });
  });

  const passphrase = deps.networkPassphrase ?? TESTNET_PASSPHRASE;

  // Builds UNSIGNED cleanup transactions (decisions.md option A): the user
  // signs them in the wallet that holds the old account's key.
  // --- Vellar x402: payment gate for POST /lifecycle/execute ---
  const PAYMENT_CONFIG = {
    payToAddress: "GD6TC7QY35TZ5VHPMGCPQUDHRBLXZEI3HCBLHTBBAY2RX3L6PBWI5C2O",
    // USDC mainnet SAC (matches @x402/stellar's DEFAULT_ASSETS for stellar:pubnet).
    asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  };

  // @x402/fastify derives the published resource.url from the INBOUND
  // request's Host header when no explicit `resource` is given — behind
  // api-gateway's proxy (which doesn't rewrite Host) that's the service's
  // own internal bind address, not a public one. Registered "localhost:4002"
  // to the public mainnet Bazaar catalog before this was caught (see
  // docs/decisions.md). publicBaseUrlFromEnv() throws and refuses to boot
  // rather than silently publishing an unreachable URL.
  const x402PublicResourceUrl = `${publicBaseUrlFromEnv()}/lifecycle/execute`;

  const x402FacilitatorClient =
    deps.x402FacilitatorClient ??
    new HTTPFacilitatorClient({ url: "https://vellar-facilitator-production.up.railway.app" });
  const x402Server = new x402ResourceServer(x402FacilitatorClient)
    .register("stellar:pubnet", new ExactStellarScheme())
    .registerExtension(bazaarResourceServerExtension);

  const x402Routes = {
    "POST /lifecycle/execute": {
      resource: x402PublicResourceUrl,
      accepts: {
        scheme: "exact" as const,
        // 0.50 USDC. `price` is a decimal-dollar Money string, not raw base
        // units — @x402/stellar's defaultMoneyConversion multiplies this by
        // the asset's decimals (7 for USDC) to get the on-chain amount.
        price: "$0.50",
        network: "stellar:pubnet" as const,
        payTo: PAYMENT_CONFIG.payToAddress,
        maxTimeoutSeconds: 300,
      },
      description: "Build unsigned Stellar transaction steps for account cleanup and migration",
      serviceName: "@vellar/lifecycle-service",
      tags: ["api", "x402", "stellar", "account-cleanup"],
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: {
          accountId: "GAQDNEHYHTNCGJN5HBS7L7NVIV7LM6HIKXNFDAM7ZLLJFNLAT4QVJKAC",
          destination: "GBB7PVDR642MJSALMD3PN4SAPZHUJP555XQMFJJNUH3AN33UQY7FVL3H",
        },
        inputSchema: {
          properties: {
            accountId: {
              type: "string",
              description: "Classic (G...) Stellar account to close and merge",
            },
            destination: {
              type: "string",
              description: "Classic (G...) Stellar account to receive the merged balance",
            },
          },
        },
        output: {
          example: {
            steps: [
              {
                title: "Clean up the account",
                description: "One transaction that will: merge account into destination.",
                xdr: "AAAAAgAAAAA...",
                hash: "3f9c2e...",
              },
            ],
            plan: {
              accountId: "GAQDNEHYHTNCGJN5HBS7L7NVIV7LM6HIKXNFDAM7ZLLJFNLAT4QVJKAC",
              destination: "GBB7PVDR642MJSALMD3PN4SAPZHUJP555XQMFJJNUH3AN33UQY7FVL3H",
              blockers: [],
              estimatedTransactions: 1,
              mergeReady: true,
            },
          },
        },
      }),
    },
  };
  // --- end Vellar x402 setup ---
  paymentMiddleware(app, x402Routes, x402Server); // Vellar x402: gate the route below
  app.post("/lifecycle/execute", async (request, reply) => {
    const parsed = planBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId, destination } = parsed.data;
    const invalid = validatePair(accountId, destination);
    if (invalid) return reply.code(400).send({ error: invalid });

    const account = await deps.reader.getAccount(accountId);
    if (!account) return reply.code(404).send({ error: "account_not_found" });

    return reply.send({
      steps: buildCleanupSteps(account, destination, passphrase),
      plan: buildCleanupPlan(account, destination),
    });
  });

  // MergePreflightValidator (idea.md §6.4): re-inspects and refuses to build
  // the merge while any blocker remains.
  app.post("/lifecycle/merge", async (request, reply) => {
    const parsed = planBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { accountId, destination } = parsed.data;
    const invalid = validatePair(accountId, destination);
    if (invalid) return reply.code(400).send({ error: invalid });

    const account = await deps.reader.getAccount(accountId);
    if (!account) return reply.code(404).send({ error: "account_not_found" });

    const plan = buildCleanupPlan(account, destination);
    if (!plan.mergeReady) {
      // §13 alerting: abnormal cleanup failure rates. A merge refused because
      // the account still has blockers is a "not ready" outcome, not success.
      recordOutcome(domainMetrics.cleanupCompleted, "lifecycle-service", "failure");
      return reply.code(409).send({ error: "not_merge_ready", plan });
    }
    recordOutcome(domainMetrics.cleanupCompleted, "lifecycle-service", "success");
    return reply.send({ step: buildMergeStep(account, destination, passphrase) });
  });

  return app;
}
