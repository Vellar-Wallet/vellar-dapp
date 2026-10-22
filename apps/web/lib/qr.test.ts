// @vitest-environment node

import jsQR from "jsqr";
import { Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { assetsFor } from "./assets";
import { isDenseQrPayload, QR_SCAN_SAFE_MAX_BYTES, qrMatrix, qrPath } from "./qr";
import { buildPayUri } from "./sep7";

const C_ADDR = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// Rasterise the matrix (with a quiet zone) and decode it with an independent
// QR reader: proves the rendered code carries exactly the intended payload.
function decode(matrix: boolean[][], scale = 4, margin = 4): string | undefined {
  const modules = matrix.length + margin * 2;
  const width = modules * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + margin) * scale + y) * width + (c + margin) * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }),
  );
  return jsQR(data, width, width)?.data;
}

describe("qrMatrix", () => {
  it("encodes a bare C-address that decodes back exactly", () => {
    expect(decode(qrMatrix(C_ADDR))).toBe(C_ADDR);
  });

  it("encodes a full SEP-7 request that decodes back exactly", () => {
    const uri = buildPayUri({
      destination: C_ADDR,
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      amount: "25.5",
      asset: assetsFor("testnet")[1],
      memo: "invoice 42",
      msg: "Thanks — see you soon",
    });
    expect(decode(qrMatrix(uri))).toBe(uri);
  });

  it("refuses non-ASCII and empty payloads rather than corrupting them", () => {
    expect(() => qrMatrix("")).toThrow();
    expect(() => qrMatrix("pay €5")).toThrow();
  });

  it("builds one path segment per dark module, offset by the margin", () => {
    const path = qrPath(
      [
        [true, false],
        [false, true],
      ],
      4,
    );
    expect(path).toBe("M4 4h1v1h-1zM5 5h1v1h-1z");
  });
});

// Scan-reliability ceiling (issue #560). A very long payload (e.g. a SEP-7 URI
// with many parameters) pushes the code past QR version 25 density, which
// typical phone cameras cannot read reliably at UI size. isDenseQrPayload
// flags that case so the receive flow can warn or shorten before rendering.
describe("isDenseQrPayload — scan-reliability threshold", () => {
  it("defines the threshold just above QR version 25 byte capacity (997 bytes at ECC M)", () => {
    expect(QR_SCAN_SAFE_MAX_BYTES).toBe(1024);
  });

  it("does not flag a payload well under the threshold", () => {
    expect(isDenseQrPayload("x".repeat(QR_SCAN_SAFE_MAX_BYTES - 2))).toBe(false);
  });

  it("does not flag a payload exactly at the threshold boundary", () => {
    // Boundary: length === QR_SCAN_SAFE_MAX_BYTES is still inside the
    // reliably scannable range and must NOT be flagged.
    expect(isDenseQrPayload("x".repeat(QR_SCAN_SAFE_MAX_BYTES))).toBe(false);
    expect(QR_SCAN_SAFE_MAX_BYTES).toBeLessThanOrEqual(1024);
  });

  it("flags a payload just over the threshold", () => {
    expect(isDenseQrPayload("x".repeat(QR_SCAN_SAFE_MAX_BYTES + 1))).toBe(true);
  });

  it("flags a long SEP-7 URI that would encode too densely to scan", () => {
    // A realistic SEP-7 request can grow past the ceiling (many params /
    // long percent-encoded msg); build the URI string directly so the
    // parser's 300-char msg cap does not limit the fixture.
    const uri = `web+stellar:pay?destination=${C_ADDR}&msg=${"p".repeat(QR_SCAN_SAFE_MAX_BYTES)}`;
    expect(uri.length).toBeGreaterThan(QR_SCAN_SAFE_MAX_BYTES);
    expect(isDenseQrPayload(uri)).toBe(true);
  });

  it("still encodes a threshold-length payload that decodes back exactly", () => {
    // At the boundary the code remains scannable: the flag is about density
    // reliability, not a hard encode failure.
    const payload = "A".repeat(QR_SCAN_SAFE_MAX_BYTES);
    expect(isDenseQrPayload(payload)).toBe(false);
    expect(decode(qrMatrix(payload))).toBe(payload);
  });
});
