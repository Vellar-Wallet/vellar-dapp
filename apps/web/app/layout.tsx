import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

const title = "Vellar, the payment layer for AI agents on Stellar";
const description =
  "Vellar verifies and settles x402 payments on Stellar, lists every paid endpoint in a searchable Bazaar, and gives sellers and agents the tools to use both. Open source, non-custodial, fees sponsored.";
// The hero itself, cropped to the canonical 1200x630 social-card size.
const ogImage = {
  url: "https://vellar.xyz/og-image.png",
  width: 1200,
  height: 630,
  alt: title,
};

export const metadata: Metadata = {
  title,
  description,
  metadataBase: new URL("https://vellar.xyz"),
  openGraph: {
    title,
    description,
    siteName: "Vellar",
    type: "website",
    images: [ogImage],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [ogImage.url],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Clash Display: app shell. Cabinet Grotesk: landing display face. */}
        <link
          href="https://api.fontshare.com/v2/css?f[]=clash-display@700,600,500,400&f[]=cabinet-grotesk@800,700,500&display=swap"
          rel="stylesheet"
        />
        {/* Playfair italic is the landing's rationed emphasis face. Anton is
            the condensed display face, rationed to the two poster-scale
            headlines (hero + closing band) — see docs/decisions.md. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Anton&family=Playfair+Display:ital,wght@1,500;1,600;1,700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
