import type { Metadata } from "next";
import type { ReactNode } from "react";
import { themeInitScript } from "@/lib/theme";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vellar — the passkey smart wallet for Stellar",
  description:
    "Web-first Stellar smart wallet: passkey onboarding, programmable account policies, contract trust signals, and account lifecycle tooling.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-theme is rendered server-side (default dark) so it matches the
    // pre-paint script; suppressHydrationWarning covers the light-mode swap.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=clash-display@700,600,500,400&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
