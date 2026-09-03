import { describe, it, expect, vi } from "vitest";
import {
  ErrorReporter,
  DefaultErrorReportClient,
  type ErrorReportPayload,
} from "./error-reporter";

describe("extension error reporter integration (#302)", () => {
  it("includes extension version and browser info in reported errors", async () => {
    const mockClient = new DefaultErrorReportClient();
    const reporter = new ErrorReporter({
      extensionVersion: "1.2.3",
      browserInfo: "Mozilla/5.0 (Windows NT 10.0; Chrome/120.0)",
      client: mockClient,
    });

    const testError = new TypeError("Network request failed");
    const payload = await reporter.reportError(testError, {
      route: "provider-request",
      origin: "https://dapp.example.com",
    });

    expect(payload.name).toBe("TypeError");
    expect(payload.message).toBe("Network request failed");
    expect(payload.context.extensionVersion).toBe("1.2.3");
    expect(payload.context.browserInfo).toBe("Mozilla/5.0 (Windows NT 10.0; Chrome/120.0)");
    expect(payload.context.origin).toBe("https://dapp.example.com");

    const reports = mockClient.getReports();
    expect(reports.length).toBe(1);
    expect(reports[0]).toEqual(payload);
  });

  it("handles non-Error objects and string throws gracefully", async () => {
    const mockClient = new DefaultErrorReportClient();
    const reporter = new ErrorReporter({ client: mockClient });

    const payload = await reporter.reportError("String error message", {
      handler: "handlePairApproval",
    });

    expect(payload.name).toBe("Error");
    expect(payload.message).toBe("String error message");
    expect(payload.context.handler).toBe("handlePairApproval");
  });

  it("catches client delivery errors without crashing the background worker", async () => {
    const failingClient = {
      send: vi.fn().mockRejectedValue(new Error("Network offline")),
    };
    const reporter = new ErrorReporter({ client: failingClient });

    const payload = await reporter.reportError(new Error("Worker error"));

    expect(failingClient.send).toHaveBeenCalledTimes(1);
    expect(payload.message).toBe("Worker error");
  });
});
