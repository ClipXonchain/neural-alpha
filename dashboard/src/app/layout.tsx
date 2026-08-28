import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Neural Alpha — Trading Dashboard",
  description: "Neural Alpha — autonomous bStock trading agent monitor",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#050608",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
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
