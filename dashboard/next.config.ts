import type { NextConfig } from "next";
import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";

/**
 * Hydrate process.env from env files.
 * Order (later wins): root .env → root .env.local → dashboard .env → dashboard .env.local
 * Already-set shell/hosting env is never overwritten.
 */
function hydrateProcessEnvFromFiles() {
  const paths = [
    resolve(__dirname, "../.env"),
    resolve(__dirname, "../.env.local"),
    resolve(__dirname, ".env"),
    resolve(__dirname, ".env.local"),
  ];
  const fromFiles: Record<string, string> = {};
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) continue;
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        fromFiles[key] = val;
      }
    } catch {
      /* ignore */
    }
  }
  for (const [key, val] of Object.entries(fromFiles)) {
    if (!process.env[key]?.trim()) {
      process.env[key] = val;
    }
  }
}

hydrateProcessEnvFromFiles();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Monorepo: avoid picking /root/package-lock.json as tracing root on VPS
  outputFileTracingRoot: join(__dirname, ".."),
  serverExternalPackages: ["@neondatabase/serverless", "viem"],
  env: {
    // Default false — owners get full controls. Public monitor deploys set true explicitly.
    NEXT_PUBLIC_READONLY: process.env.NEXT_PUBLIC_READONLY ?? "false",
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID:
      process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
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
  ],
};

export default nextConfig;
