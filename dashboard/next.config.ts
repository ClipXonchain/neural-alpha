import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function config(phase: string): NextConfig {
  const isDevServer = phase === PHASE_DEVELOPMENT_SERVER;

  return {
    reactStrictMode: true,
    poweredByHeader: false,
    devIndicators: false,
    compress: true,
    experimental: {
      optimizePackageImports: ["lucide-react", "recharts", "framer-motion"],
    },
    env: {
      NEXT_PUBLIC_READONLY: process.env.NEXT_PUBLIC_READONLY ?? "false",
    },
    async redirects() {
      return [{ source: "/system", destination: "/about", permanent: true }];
    },
    headers: async () => [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            // Production chunks are content-hashed, so they can be cached forever.
            // The dev server reuses chunk names across edits, so it must never be
            // cached or the browser keeps serving stale UI after a save.
            value: isDevServer ? "no-store, must-revalidate" : "public, max-age=31536000, immutable",
          },
        ],
      },
    ],
  };
}
