"use client";

import { useMemo } from "react";
import { qrMatrix, qrPath } from "@/lib/qr";

export const QUIET_ZONE = 4;
/** Smallest supported container size (in CSS pixels) that keeps QR modules scannable on mobile cameras. */
export const MIN_QR_SIZE = 120;
/** Minimum rendered size (in CSS pixels) per QR module including the quiet zone. */
export const MIN_QR_MODULE_PX = 2;

export function qrModuleSizePx(extent: number, size: number): number {
  if (extent <= 0) return 0;
  return Math.max(MIN_QR_SIZE, size) / extent;
}

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
  const resolvedSize = Math.max(MIN_QR_SIZE, size);
  const { path, extent } = useMemo(() => {
    const matrix = qrMatrix(value);
    return {
      path: qrPath(matrix, QUIET_ZONE),
      extent: matrix.length + QUIET_ZONE * 2,
    };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="receive-qr"
      data-qr-payload={value}
      width={resolvedSize}
      height={resolvedSize}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className="block rounded-md"
    >
      <rect width={extent} height={extent} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
