// @vitest-environment node

import jsQR from "jsqr";
import { Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { assetsFor } from "./assets";
import {
  QR_SCAN_RELIABILITY_THRESHOLD,
  QrPayloadLengthError,
  assessQrPayloadReliability,
  encodeQrPayload,
  qrMatrix,
  qrPath,
} from "./qr";
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

  describe("scan-reliability payload length threshold (#560)", () => {
    it("marks payloads below the threshold as optimal and encodes with EC level M", () => {
      const belowPayload = "x".repeat(QR_SCAN_RELIABILITY_THRESHOLD - 1);
      const assessment = assessQrPayloadReliability(belowPayload);

      expect(assessment.byteLength).toBe(QR_SCAN_RELIABILITY_THRESHOLD - 1);
      expect(assessment.threshold).toBe(QR_SCAN_RELIABILITY_THRESHOLD);
      expect(assessment.exceedsThreshold).toBe(false);
      expect(assessment.status).toBe("optimal");
      expect(assessment.recommendedErrorCorrection).toBe("M");
      expect(assessment.warning).toBeUndefined();

      const encoded = encodeQrPayload(belowPayload);
      expect(encoded.exceedsThreshold).toBe(false);
      expect(encoded.errorCorrectionLevel).toBe("M");
      expect(decode(encoded.matrix)).toBe(belowPayload);
    });

    it("treats a payload right at the threshold boundary as optimal (level M)", () => {
      const boundaryPayload = "a".repeat(QR_SCAN_RELIABILITY_THRESHOLD);
      const assessment = assessQrPayloadReliability(boundaryPayload);

      expect(assessment.byteLength).toBe(QR_SCAN_RELIABILITY_THRESHOLD);
      expect(assessment.exceedsThreshold).toBe(false);
      expect(assessment.status).toBe("optimal");
      expect(assessment.recommendedErrorCorrection).toBe("M");
      expect(assessment.warning).toBeUndefined();

      const encoded = encodeQrPayload(boundaryPayload);
      expect(encoded.exceedsThreshold).toBe(false);
      expect(encoded.errorCorrectionLevel).toBe("M");
      expect(decode(encoded.matrix)).toBe(boundaryPayload);
    });

    it("flags payloads above the threshold and switches to lower-density EC level L", () => {
      const overPayload = "b".repeat(QR_SCAN_RELIABILITY_THRESHOLD + 1);
      const assessment = assessQrPayloadReliability(overPayload);

      expect(assessment.byteLength).toBe(QR_SCAN_RELIABILITY_THRESHOLD + 1);
      expect(assessment.exceedsThreshold).toBe(true);
      expect(assessment.status).toBe("degraded_density");
      expect(assessment.recommendedErrorCorrection).toBe("L");
      expect(assessment.warning).toContain(String(QR_SCAN_RELIABILITY_THRESHOLD));

      const encoded = encodeQrPayload(overPayload);
      const forcedM = qrMatrix(overPayload, { errorCorrectionLevel: "M" });

      expect(encoded.exceedsThreshold).toBe(true);
      expect(encoded.errorCorrectionLevel).toBe("L");
      // Level L produces a smaller (lower-density) module grid than Level M for oversized payloads
      expect(encoded.moduleCount).toBeLessThan(forcedM.length);
      expect(decode(encoded.matrix)).toBe(overPayload);
    });

    it("throws QrPayloadLengthError when rejectOverThreshold is enabled for oversized payloads", () => {
      const boundaryPayload = "c".repeat(QR_SCAN_RELIABILITY_THRESHOLD);
      const overPayload = "c".repeat(QR_SCAN_RELIABILITY_THRESHOLD + 1);

      expect(() => qrMatrix(boundaryPayload, { rejectOverThreshold: true })).not.toThrow();
      expect(() => qrMatrix(overPayload, { rejectOverThreshold: true })).toThrowError(
        QrPayloadLengthError,
      );
    });
  });
});
