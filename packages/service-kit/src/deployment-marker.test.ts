import { describe, expect, it } from "vitest";
import { ensureDeploymentMarker, type MarkerClient } from "./deployment-marker";

// The decision paths that need no database. The behaviour against real Postgres (both
// directions, fresh vs non-fresh, concurrency, no writes on refusal) is in
// services/wallet-service/src/db/deployment-marker.test.ts.

const explodingClient: MarkerClient = {
  query: async (text) => {
    throw new Error(`development must not touch the database, but ran: ${text.slice(0, 40)}`);
  },
};

describe("ensureDeploymentMarker", () => {
  it("does nothing at all for DEPLOY_ENV=development (local, throwaway databases)", async () => {
    await expect(
      ensureDeploymentMarker(explodingClient, "development", {}),
    ).resolves.toBeUndefined();
  });
});
