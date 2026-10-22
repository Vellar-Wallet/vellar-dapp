import qrcode from "qrcode-generator";

// Local QR encoding. The payload (a wallet address or SEP-7 URI) never leaves
// the device — no third-party QR service is involved.

/**
 * Scan-reliability ceiling for a QR payload, in bytes: 1024.
 *
 * Why 1024: at ECC level M the byte-mode capacity of QR version 25 is 997
 * bytes (117×117 modules). Phone cameras reliably scan up to roughly that
 * density when the code is shown at UI size; beyond it the modules are too
 * fine and recognition fails on typical hardware. 1024 is the nearest round
 * number just above the version-25 capacity, so a payload at the threshold
 * still encodes inside the reliably scannable range and anything past it is
 * flagged before it is rendered.
 */
export const QR_SCAN_SAFE_MAX_BYTES = 1024;

/**
 * True when `payload` would encode past the scan-reliability ceiling and
 * should be flagged in the UI (shortened, or shown with a density warning).
 */
export function isDenseQrPayload(payload: string): boolean {
  return payload.length > QR_SCAN_SAFE_MAX_BYTES;
}

/** Dark-module matrix for `payload` (row-major, true = dark). */
export function qrMatrix(payload: string): boolean[][] {
  // The default byte mode maps each UTF-16 unit to one byte, so anything
  // outside ASCII would be silently corrupted. Addresses and percent-encoded
  // SEP-7 URIs are always ASCII; refuse anything else loudly.
  if (!/^[\x20-\x7e]+$/.test(payload)) {
    throw new Error("QR payload must be non-empty printable ASCII");
  }
  // Level M (~15% recovery) keeps long SEP-7 URIs scannable at a modest size.
  const qr = qrcode(0, "M");
  qr.addData(payload, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => qr.isDark(r, c)),
  );
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
