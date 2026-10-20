import qrcode from "qrcode-generator";

// Local QR encoding. The payload (a wallet address or SEP-7 URI) never leaves
// the device — no third-party QR service is involved.

/**
 * Maximum ASCII byte length before a QR code at Error Correction Level M (~15%)
 * jumps beyond Version 11 (61x61 modules), where module density inside compact
 * mobile viewports begins degrading real-world camera scan reliability.
 *
 * Payloads up to and including this boundary use EC level "M" ("optimal").
 * Payloads exceeding this threshold are flagged with a scan-reliability warning
 * and automatically encoded with EC level "L" (~7% recovery) to reduce module
 * density unless overridden or explicitly rejected.
 */
export const QR_SCAN_RELIABILITY_THRESHOLD = 256;

export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";

export type QrReliabilityStatus = "optimal" | "degraded_density";

export interface QrPayloadReliabilityAssessment {
  byteLength: number;
  threshold: number;
  exceedsThreshold: boolean;
  status: QrReliabilityStatus;
  recommendedErrorCorrection: QrErrorCorrectionLevel;
  warning?: string;
}

export interface QrMatrixOptions {
  /** Override the scan-reliability byte threshold (defaults to QR_SCAN_RELIABILITY_THRESHOLD). */
  threshold?: number;
  /** Override the QR error-correction level. Defaults to "M" up to threshold and "L" above threshold. */
  errorCorrectionLevel?: QrErrorCorrectionLevel;
  /** When true, throws QrPayloadLengthError if payload length exceeds the threshold. */
  rejectOverThreshold?: boolean;
}

export interface EncodedQrPayload extends QrPayloadReliabilityAssessment {
  matrix: boolean[][];
  moduleCount: number;
  errorCorrectionLevel: QrErrorCorrectionLevel;
}

export class QrPayloadLengthError extends Error {
  readonly code = "QR_PAYLOAD_LENGTH_EXCEEDED" as const;
  readonly byteLength: number;
  readonly threshold: number;

  constructor(byteLength: number, threshold: number) {
    super(
      `QR payload length (${byteLength} bytes) exceeds scan-reliability threshold (${threshold} bytes)`,
    );
    this.name = "QrPayloadLengthError";
    this.byteLength = byteLength;
    this.threshold = threshold;
  }
}

function assertPrintableAscii(payload: string): void {
  // The default byte mode maps each UTF-16 unit to one byte, so anything
  // outside ASCII would be silently corrupted. Addresses and percent-encoded
  // SEP-7 URIs are always ASCII; refuse anything else loudly.
  if (!/^[\x20-\x7e]+$/.test(payload)) {
    throw new Error("QR payload must be non-empty printable ASCII");
  }
}

/**
 * Assess whether a QR payload falls within the safe scan-reliability threshold
 * or exceeds it (requiring lower-density EC mode and/or user warning).
 */
export function assessQrPayloadReliability(
  payload: string,
  threshold: number = QR_SCAN_RELIABILITY_THRESHOLD,
): QrPayloadReliabilityAssessment {
  assertPrintableAscii(payload);
  const byteLength = payload.length;
  const exceedsThreshold = byteLength > threshold;
  if (exceedsThreshold) {
    return {
      byteLength,
      threshold,
      exceedsThreshold: true,
      status: "degraded_density",
      recommendedErrorCorrection: "L",
      warning: `Payload length (${byteLength} bytes) exceeds safe scan-reliability threshold (${threshold} bytes); switching to low-density error correction (level L).`,
    };
  }
  return {
    byteLength,
    threshold,
    exceedsThreshold: false,
    status: "optimal",
    recommendedErrorCorrection: "M",
  };
}

/** Dark-module matrix for `payload` (row-major, true = dark). */
export function qrMatrix(payload: string, options?: QrMatrixOptions): boolean[][] {
  const threshold = options?.threshold ?? QR_SCAN_RELIABILITY_THRESHOLD;
  const assessment = assessQrPayloadReliability(payload, threshold);

  if (assessment.exceedsThreshold && options?.rejectOverThreshold) {
    throw new QrPayloadLengthError(assessment.byteLength, threshold);
  }

  // Level M (~15% recovery) keeps normal SEP-7 URIs scannable at a modest size.
  // Above the scan-reliability threshold, drop to Level L (~7% recovery) to keep
  // module density lower and preserve camera scannability on small screens.
  const ecLevel = options?.errorCorrectionLevel ?? assessment.recommendedErrorCorrection;
  const qr = qrcode(0, ecLevel);
  qr.addData(payload, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => qr.isDark(r, c)),
  );
}

/**
 * Encode `payload` into a QR matrix alongside its scan-reliability assessment
 * so callers can surface a high-density warning or adapt rendering when the
 * payload exceeds `QR_SCAN_RELIABILITY_THRESHOLD`.
 */
export function encodeQrPayload(payload: string, options?: QrMatrixOptions): EncodedQrPayload {
  const threshold = options?.threshold ?? QR_SCAN_RELIABILITY_THRESHOLD;
  const assessment = assessQrPayloadReliability(payload, threshold);
  const errorCorrectionLevel =
    options?.errorCorrectionLevel ?? assessment.recommendedErrorCorrection;
  const matrix = qrMatrix(payload, {
    ...options,
    threshold,
    errorCorrectionLevel,
  });
  return {
    ...assessment,
    matrix,
    moduleCount: matrix.length,
    errorCorrectionLevel,
  };
}

/** One SVG path covering every dark module, offset by a quiet zone of `margin` modules. */
export function qrPath(matrix: boolean[][], margin: number): string {
  let d = "";
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }),
  );
  return d;
}
