import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./clipx.css";

const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "Neural Alpha — Trading Dashboard",
  description: "Neural Alpha — autonomous bStock trading agent monitor",
  icons: { icon: "/brand/neural-alpha-mark.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#080c10",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${sans.variable} ${mono.variable}`}>
      <head>
        <link rel="preconnect" href="https://bin.bnbstatic.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://bin.bnbstatic.com" />
      </head>
      <body className="min-h-screen bg-void antialiased">
        {children}
      </body>
    </html>
  );
}
