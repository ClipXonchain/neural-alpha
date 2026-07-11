import { NextRequest } from "next/server";
import { getAgentApiSecret } from "@/lib/agent-secrets";
import { resolveRuntimeUrl } from "@/lib/agent-runtime";
import { getAgentApiUrl } from "@/lib/agent-url";
import { getAgent } from "@/lib/platform-registry";
import { supervisorResolveUrl } from "@/lib/supervisor-client";
import {
  isMutationMethod,
  isPublicAgentGet,
  isReadonlyDeploy,
  requireOperatorSession,
  requireOwnerSession,
} from "@/lib/proxy-security";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
/** Trades / wallet sync can take 1–2 min (approve + on-chain swap). */
export const maxDuration = 300;

const LONG_RUNNING_PATHS = new Set([
  "command",
  "wallet/sync",
  "control/resync",
  "control/start",
]);

const UPSTREAM_TIMEOUT_MS = 180_000;

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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Agent-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/**
 * Resolve upstream agent URL.
 * Supports:
 *   /api/agent/<path>                 → default local agent
 *   /api/agent/<agentId>/<path>       → multi-tenant agent from registry
 *   X-Agent-Id header                 → same as path prefix
 */
async function resolveUpstream(
  req: NextRequest,
  pathParts: string[]
): Promise<{
  base: string;
  agentPath: string;
  bearerSecret?: string;
}> {
  const readonly = isReadonlyDeploy(req);
  const isMutation = isMutationMethod(req.method);

  const headerId = req.headers.get("x-agent-id")?.trim();
  let agentId = headerId || undefined;
  let rest = pathParts;

  if (
    !agentId &&
    pathParts[0] &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      pathParts[0]
    )
  ) {
    agentId = pathParts[0];
    rest = pathParts.slice(1);
  }

  const agentPath = (agentId ? rest : pathParts).join("/");

  if (readonly && isMutation) {
    throw new Error("Forbidden: read-only deployment");
  }

  if (agentId) {
    const agent = await getAgent(agentId);
    if (!agent?.runtime_url) {
      throw new Error("Agent runtime not found");
    }

    const publicGet = !isMutation && isPublicAgentGet(agentPath);

    if (isMutation) {
      await requireOwnerSession(agent.owner_wallet);
    } else if (!readonly && !publicGet) {
      await requireOwnerSession(agent.owner_wallet);
    }

    const bearerSecret = readonly ? undefined : await getAgentApiSecret(agentId);

    const diskOrDb =
      resolveRuntimeUrl(agentId, agent.runtime_url) || agent.runtime_url;
    // Prefer live Supervisor registry so port drift never leaks to wrong agent
    const base =
      (await supervisorResolveUrl(agentId, diskOrDb)) || diskOrDb;

    return {
      base: base.replace(/\/$/, ""),
      agentPath,
      bearerSecret,
    };
  }

  // Legacy default agent path (single local agent) — disabled when multi-tenant DB is set
  if (process.env.DATABASE_URL?.trim()) {
    throw new Error("Agent id required — singleton proxy disabled in multi-tenant mode");
  }

  if (isMutation) {
    await requireOperatorSession();
  } else if (!readonly && !isPublicAgentGet(agentPath)) {
    await requireOperatorSession();
  }

  const session = await getSession();
  const bearerSecret =
    readonly || !session.isLoggedIn
      ? undefined
      : (await getAgentApiSecret("default")) ||
        process.env.API_SECRET?.trim();

  return {
    base: getAgentApiUrl(),
    agentPath,
    bearerSecret,
  };
}

async function proxyToAgent(req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  const origin = req.headers.get("origin");
  const respCors = corsHeaders(origin);

  let upstream: { base: string; agentPath: string; bearerSecret?: string };
  try {
    upstream = await resolveUpstream(req, path);
  } catch (err) {
    const msg = String(err);
    let status = 500;
    if (/Unauthorized/i.test(msg)) status = 401;
    else if (/Forbidden/i.test(msg)) status = 403;
    else if (/not found/i.test(msg)) status = 404;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "Content-Type": "application/json", ...respCors },
    });
  }

  const target = `${upstream.base}/api/${upstream.agentPath}${req.nextUrl.search}`;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  const clientAuth = req.headers.get("authorization") ?? req.headers.get("x-api-key");
  if (clientAuth) {
    headers.set(
      "Authorization",
      clientAuth.startsWith("Bearer ") ? clientAuth : `Bearer ${clientAuth}`
    );
  } else if (upstream.bearerSecret) {
    headers.set("Authorization", `Bearer ${upstream.bearerSecret}`);
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    signal: LONG_RUNNING_PATHS.has(upstream.agentPath)
      ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      : req.signal,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  try {
    const res = await fetch(target, init);

    if (upstream.agentPath === "events") {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = /abort|timeout/i.test(msg);
    return new Response(
      JSON.stringify({
        error: timedOut
          ? "Agent command timed out: trade may still be processing on-chain"
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
