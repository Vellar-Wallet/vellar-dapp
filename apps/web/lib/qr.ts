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

export const LOW_CONTRAST_RATIO_THRESHOLD = 3;

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error("QR contrast colors must be 6-digit hex values");
  }
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const l1 = luminance(foreground);
  const l2 = luminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function isLowContrastQrRendering(
  foreground = "#000000",
  background = "#ffffff",
  threshold = LOW_CONTRAST_RATIO_THRESHOLD,
): boolean {
  return contrastRatio(foreground, background) < threshold;
}

/**
 * True when `payload` would encode past the scan-reliability ceiling and
 * should be flagged in the UI (shortened, or shown with a density warning).
 */
export function isDenseQrPayload(payload: string): boolean {
  return payload.length > QR_SCAN_SAFE_MAX_BYTES;
}

export function qrScanReliabilityWarning(options: {
  payload: string;
  foreground?: string;
  background?: string;
}): string | null {
  const dense = isDenseQrPayload(options.payload);
  const lowContrast = isLowContrastQrRendering(options.foreground, options.background);
  if (dense && lowContrast) {
    return "QR code may be hard to scan: payload is dense and rendering contrast is low.";
  }
  if (dense) {
    return "QR code may be hard to scan: payload is too dense for reliable scanning.";
  }
  if (lowContrast) {
    return "QR code may be hard to scan: rendering contrast is too low.";
  }
  return null;
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
