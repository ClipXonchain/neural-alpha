import { NextRequest } from "next/server";
import { getAgentApiUrl } from "@/lib/agent-url";

export const dynamic = "force-dynamic";

const API_SECRET = process.env.API_SECRET?.trim();
const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ?? "https://agents.clipx.app,http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
);

type RouteContext = { params: Promise<{ path: string[] }> };

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

async function proxyToAgent(req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  const agentPath = path.join("/");
  const agentBase = getAgentApiUrl();
  const target = `${agentBase}/api/${agentPath}${req.nextUrl.search}`;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  // Forward auth: client-supplied → fallback to server-side secret
  const clientAuth = req.headers.get("authorization") ?? req.headers.get("x-api-key");
  if (clientAuth) {
    headers.set("Authorization", clientAuth.startsWith("Bearer ") ? clientAuth : `Bearer ${clientAuth}`);
  } else if (API_SECRET) {
    headers.set("Authorization", `Bearer ${API_SECRET}`);
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    signal: req.signal,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  const origin = req.headers.get("origin");
  const respCors = corsHeaders(origin);

  try {
    const res = await fetch(target, init);

    if (agentPath === "events") {
      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...respCors,
        },
      });
    }

    const outHeaders = new Headers(respCors);
    const resType = res.headers.get("content-type");
    if (resType) outHeaders.set("Content-Type", resType);
    outHeaders.set("X-Content-Type-Options", "nosniff");

    return new Response(res.body, { status: res.status, headers: outHeaders });
  } catch {
    return new Response(JSON.stringify({ error: "Agent API unreachable" }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...respCors },
    });
  }
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  return proxyToAgent(req, ctx);
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  return proxyToAgent(req, ctx);
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}
