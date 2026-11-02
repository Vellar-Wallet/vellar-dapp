import { describe, expect, it } from "vitest";
import {
  DeploymentMarkerError,
  ensureDeploymentMarker,
  type MarkerClient,
} from "./deployment-marker";

// The decision paths that need no database. The behaviour against real Postgres (both
// directions, fresh vs non-fresh, concurrency, no writes on refusal) is in
// services/wallet-service/src/db/deployment-marker.test.ts.

/** A client that answers only the marker READ (no table, or a table holding `row`). */
function readOnlyFake(row?: "production" | "staging"): { client: MarkerClient; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    client: {
      query: async (text) => {
        if (/to_regclass/.test(text)) return { rows: [{ reg: row ? "deployment_marker" : null }] };
        if (/SELECT deploy_env/.test(text)) return { rows: row ? [{ deploy_env: row }] : [] };
        writes.push(text);
        throw new Error(`development must not write, but ran: ${text.slice(0, 40)}`);
      },
    },
  };
}

describe("ensureDeploymentMarker, development", () => {
  it("passes on a database with no marker and writes nothing", async () => {
    const { client, writes } = readOnlyFake();
    await expect(ensureDeploymentMarker(client, "development", {})).resolves.toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("passes on a database marked staging", async () => {
    const { client } = readOnlyFake("staging");
    await expect(ensureDeploymentMarker(client, "development", {})).resolves.toBeUndefined();
  });

  it("REFUSES a database marked production", async () => {
    const { client, writes } = readOnlyFake("production");
    await expect(ensureDeploymentMarker(client, "development", {})).rejects.toThrow(
      DeploymentMarkerError,
    );
    await expect(ensureDeploymentMarker(client, "development", {})).rejects.toThrow(
      /development.*marked 'production'/,
    );
    expect(writes).toEqual([]);
  });
});
