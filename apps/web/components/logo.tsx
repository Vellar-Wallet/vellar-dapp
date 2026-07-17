"use client";

import { useTheme } from "@/lib/theme";

// Theme-aware wordmark. Asset is 2000×989 (~2.023:1). Lock BOTH dimensions to
// the TRUE aspect ratio so the image is never squished, and keep
// object-fit:contain as a final guard. logo-light = knocked-out light mark
// (dark surfaces); logo-mark = green mark (light surfaces).

const ASPECT = 2000 / 989;

export function Logo({ height = 30 }: { height?: number }) {
  const { theme } = useTheme();
  const src = theme === "light" ? "/logo-mark.png" : "/logo-light.png";
  const width = Math.round(height * ASPECT);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="VELA"
      width={width}
      height={height}
      decoding="async"
      style={{
        width,
        height,
        display: "block",
        objectFit: "contain",
        flexShrink: 0,
        // Preserve the mark's crisp anti-aliased edges when downscaled.
        imageRendering: "auto",
      }}
    />
  );
}
