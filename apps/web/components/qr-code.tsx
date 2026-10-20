"use client";

import { useMemo } from "react";
import { qrMatrix, qrPath } from "@/lib/qr";

export const QUIET_ZONE = 4;

/**
 * Documented minimum supported container size (px) ensuring scannability across
 * all supported payload lengths up to the highest QR version (version 40 = 177 modules,
 * extent = 185 with quiet zone).
 */
export const MIN_QR_SIZE = 185;

/** Minimum module pixel size threshold required for reliable camera scanning. */
export const MIN_MODULE_PX = 1;

// Rendered as an SVG path built from the module matrix — no innerHTML, and the
// payload is encoded on-device.
export function QrCode({
  value,
  label,
  size = 208,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { path, extent } = useMemo(() => {
    const matrix = qrMatrix(value);
    return { path: qrPath(matrix, QUIET_ZONE), extent: matrix.length + QUIET_ZONE * 2 };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="receive-qr"
      data-qr-payload={value}
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className="block rounded-md"
    >
      <rect width={extent} height={extent} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
