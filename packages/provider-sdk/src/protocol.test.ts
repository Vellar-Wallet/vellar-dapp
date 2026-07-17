import { describe, expect, it } from "vitest";
import {
  errorPayload,
  parseRequestEnvelope,
  parseResponseEnvelope,
  requestEnvelope,
  responseEnvelope,
} from "./protocol";

describe("parseRequestEnvelope", () => {
  it("round-trips a valid connect request", () => {
    const envelope = requestEnvelope("id-1", { method: "connect", params: { network: "testnet" } });
    expect(parseRequestEnvelope(envelope)).toEqual(envelope);
  });

  it("round-trips a valid sign_transaction request", () => {
    const envelope = requestEnvelope("id-2", {
      method: "sign_transaction",
      params: { xdr: "AAAA", network: "testnet" },
    });
    expect(parseRequestEnvelope(envelope)).toEqual(envelope);
  });

  it.each([
    ["unrelated postMessage traffic", { source: "react-devtools" }],
    ["wrong channel", { channel: "other", kind: "request", id: "1", request: {} }],
    [
      "unknown method",
      requestEnvelope("1", { method: "connect", params: { network: "testnet" } }) && {
        channel: "vela-provider",
        kind: "request",
        id: "1",
        request: { method: "steal_keys", params: {} },
      },
    ],
    [
      "missing xdr",
      {
        channel: "vela-provider",
        kind: "request",
        id: "1",
        request: { method: "sign_transaction", params: { network: "testnet" } },
      },
    ],
    [
      "bad network",
      {
        channel: "vela-provider",
        kind: "request",
        id: "1",
        request: { method: "connect", params: { network: "devnet" } },
      },
    ],
    ["null", null],
    ["string", "hello"],
  ])("rejects %s", (_label, data) => {
    expect(parseRequestEnvelope(data)).toBeUndefined();
  });
});

describe("parseResponseEnvelope", () => {
  it("accepts results and errors", () => {
    const ok = responseEnvelope("id-1", {
      method: "connect",
      result: { address: "CABC", network: "testnet" },
    });
    expect(parseResponseEnvelope(ok)).toEqual(ok);

    const err = responseEnvelope("id-2", errorPayload("rejected", "user said no"));
    expect(parseResponseEnvelope(err)).toEqual(err);
  });

  it("rejects malformed payloads", () => {
    expect(
      parseResponseEnvelope({
        channel: "vela-provider",
        kind: "response",
        id: "1",
        payload: { method: "connect", result: { address: "" } },
      }),
    ).toBeUndefined();
    expect(parseResponseEnvelope({ kind: "response" })).toBeUndefined();
  });
});
