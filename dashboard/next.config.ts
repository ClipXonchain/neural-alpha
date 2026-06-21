import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const agentUrl = process.env.AGENT_API_URL || "http://localhost:3847";
    return [
      {
        source: "/api/agent/:path*",
        destination: `${agentUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
