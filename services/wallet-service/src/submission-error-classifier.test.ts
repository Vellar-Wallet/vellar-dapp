import { describe, expect, it } from "vitest";
import { SubmissionError } from "./relayer";
import {
  classifySubmissionError,
  isTransientSubmissionFailure,
} from "./submission-error-classifier";

describe("submission-error-classifier", () => {
  it("classifies sequence number too far in the future as permanent", () => {
    const err = new SubmissionError(
      "tx_bad_seq: sequence number 42 is too far in the future for account GABC...",
      "tx_bad_seq_future",
    );

    expect(isTransientSubmissionFailure(err)).toBe(false);
    expect(classifySubmissionError(err)).toMatchObject({
      classification: "permanent",
      code: "tx_bad_seq_future",
      isSubmissionError: true,
    });
  });

  it("keeps stale/too-low sequence timeout behavior transient", () => {
    const err = new SubmissionError("tx timeout waiting for confirmation", "tx_timeout");
    expect(isTransientSubmissionFailure(err)).toBe(true);
  });
});
