import { describe, expect, it } from "vitest";
import {
  createRelayerSubmitter,
  createUnconfiguredSubmitter,
  SubmissionError,
  type PasskeyServerLike,
} from "./relayer";

describe("createRelayerSubmitter", () => {
  it("resolves with the hash on success", async () => {
    const server: PasskeyServerLike = {
      send: async () => ({ success: true, hash: "abc123" }),
    };
    await expect(createRelayerSubmitter(server).submit("xdr")).resolves.toEqual({
      hash: "abc123",
    });
  });

  it("throws SubmissionError with the relayer's code and message on failure", async () => {
    const server: PasskeyServerLike = {
      send: async () => ({
        success: false,
        error: { code: "insufficient_fee", message: "fee too low" },
      }),
    };
    const attempt = createRelayerSubmitter(server).submit("xdr");
    await expect(attempt).rejects.toBeInstanceOf(SubmissionError);
    await expect(attempt).rejects.toMatchObject({ code: "insufficient_fee" });
  });

  it("propagates transport errors from send()", async () => {
    const server: PasskeyServerLike = {
      send: async () => {
        throw new Error("network down");
      },
    };
    await expect(createRelayerSubmitter(server).submit("xdr")).rejects.toThrow("network down");
  });
});

describe("createUnconfiguredSubmitter", () => {
  it("always rejects with relayer_not_configured", async () => {
    const attempt = createUnconfiguredSubmitter().submit("xdr");
    await expect(attempt).rejects.toBeInstanceOf(SubmissionError);
    await expect(attempt).rejects.toMatchObject({ code: "relayer_not_configured" });
  });
});
