import { describe, expect, it, vi } from "vitest";
import {
  createVerificationClient,
  trustSignal,
  VerificationApiError,
  type SubmitVerificationInput,
} from "./index";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const submitInput: SubmitVerificationInput = {
  contractId: C1,
  sourceType: "repo",
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.81.0",
};

describe("createVerificationClient", () => {
  it("submits to /verification/submit and returns the record", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ record: { id: "r1", contractId: C1, status: "submitted" } }, 201),
    );
    const client = createVerificationClient({ apiUrl: "https://api.test/", fetch: fetchMock });

    const record = await client.submit(submitInput);
    expect(record.id).toBe("r1");

    const [url, init] = fetchMock.mock.calls[0]!;
    // Trailing slash on apiUrl is normalized (no double slash).
    expect(url).toBe("https://api.test/verification/submit");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toMatchObject({ contractId: C1, sourceType: "repo" });
  });

  it("fetches history from /verification/:contractId", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ records: [{ id: "r2", contractId: C1, status: "verified" }] }),
    );
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    const history = await client.getHistory(C1);
    expect(history).toHaveLength(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.test/verification/${C1}`);
  });

  it("fetches status from /verification/:contractId/status", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ contractId: C1, status: "verified", recordId: "r2" }),
    );
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    const status = await client.getStatus(C1);
    expect(status.status).toBe("verified");
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.test/verification/${C1}/status`);
  });

  it("throws a typed VerificationApiError on a non-2xx response", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: "invalid_body" }, 400));
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    await expect(client.submit(submitInput)).rejects.toMatchObject({
      name: "VerificationApiError",
      status: 400,
      code: "invalid_body",
    });
  });

  it("wraps a network failure as VerificationApiError with status 0", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    await expect(client.getStatus(C1)).rejects.toBeInstanceOf(VerificationApiError);
    await expect(client.getStatus(C1)).rejects.toMatchObject({ status: 0 });
  });

  it("url-encodes the contract id in path lookups", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ contractId: "a/b", status: "unverified" }),
    );
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    await client.getStatus("a/b");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/verification/a%2Fb/status");
  });
});

describe("trustSignal", () => {
  it("maps each status to a stable label + tone", () => {
    expect(trustSignal("verified")).toEqual({ label: "Verified source", tone: "verified" });
    expect(trustSignal("failed")).toEqual({ label: "Verification failed", tone: "warning" });
    expect(trustSignal("submitted").tone).toBe("pending");
    expect(trustSignal("building").tone).toBe("pending");
    expect(trustSignal("unverified")).toEqual({ label: "Unverified", tone: "neutral" });
  });
});
