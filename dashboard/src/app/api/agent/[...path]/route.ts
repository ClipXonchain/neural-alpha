import { NextRequest } from "next/server";
import { getAgentApiUrl } from "@/lib/agent-url";
import { getServerEnv } from "@/lib/server-env";

export const dynamic = "force-dynamic";
/** Trades / wallet sync can take 1–2 min (Agentic Wallet swap + on-chain confirm). */
export const maxDuration = 300;

function apiSecret(): string | undefined {
  return getServerEnv("API_SECRET");
}

const PUBLIC_DASHBOARD_HOSTS = new Set(["agents.clipx.app"]);
const LONG_RUNNING_PATHS = new Set([
  "control/sell",
  "wallet/sync",
  "control/resync",
  "wallet/mode",
  "wallet/signin",
  "wallet/verify",
  "competition/register",
  "campaign/ai-tasks",
  "control/start",
]);

const UPSTREAM_TIMEOUT_MS = 180_000;
const GET_TIMEOUT_MS = 8_000;

function isReadonlyDeploy(req: NextRequest): boolean {
  const host = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
  // Only the public dashboard hostname is read-only. Localhost operator UI
  // may still trade even if READONLY=true in repo .env (used for PM2 public build).
  return PUBLIC_DASHBOARD_HOSTS.has(host);
}
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

function upstreamSignal(req: NextRequest, agentPath: string): AbortSignal {
  if (agentPath === "events") return req.signal;
  const timeout = LONG_RUNNING_PATHS.has(agentPath)
    ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    : AbortSignal.timeout(GET_TIMEOUT_MS);
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([req.signal, timeout]);
  }
  return timeout;
}

/** Swallow mid-stream disconnects (agent restart) so they don't fill error logs. */
function guardUpstreamStream(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        controller.close();
      }
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  });
}

async function proxyToAgent(req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  const agentPath = path.join("/");
  const agentBase = getAgentApiUrl();
  const target = `${agentBase}/api/${agentPath}${req.nextUrl.search}`;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  // Forward auth: client-supplied → fallback to server-side secret.
  // In READONLY mode we never auto-inject the secret so the public site can read
  // (GET) but cannot mutate (POST) — the agent rejects unauthenticated POSTs.
  const clientAuth = req.headers.get("authorization") ?? req.headers.get("x-api-key");
  if (clientAuth) {
    headers.set("Authorization", clientAuth.startsWith("Bearer ") ? clientAuth : `Bearer ${clientAuth}`);
  } else if (apiSecret() && !isReadonlyDeploy(req)) {
    headers.set("Authorization", `Bearer ${apiSecret()}`);
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    signal: upstreamSignal(req, agentPath),
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  const origin = req.headers.get("origin");
  const respCors = corsHeaders(origin);

  try {
    const res = await fetch(target, init);

    if (agentPath === "events") {
      return new Response(guardUpstreamStream(res.body), {
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

    return new Response(guardUpstreamStream(res.body) ?? res.body, {
      status: res.status,
      headers: outHeaders,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = /abort|timeout/i.test(msg);
    return new Response(
      JSON.stringify({
        error: timedOut
          ? "Agent command timed out — trade may still be processing on-chain"
          : "Agent API unreachable",
      }),
      {
        status: timedOut ? 504 : 502,
        headers: { "Content-Type": "application/json", ...respCors },
      }
    );
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
