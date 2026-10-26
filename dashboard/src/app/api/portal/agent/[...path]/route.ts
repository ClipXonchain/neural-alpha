import { cookies } from "next/headers";
import { controlBase, parseSession, SESSION_COOKIE } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(req: Request, ctx: RouteContext) {
  const jar = await cookies();
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return Response.json({ error: "no agent on this browser" }, { status: 401 });
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const target = `${controlBase()}/tenants/${session.tenantId}/agent/${path.join("/")}${url.search}`;
  const headers = new Headers();
  headers.set("authorization", `Bearer ${session.raw}`);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const init: RequestInit = { method: req.method, headers, cache: "no-store" };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();
  const upstream = await fetch(target, init);
  const responseHeaders = new Headers();
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) responseHeaders.set("content-type", upstreamType);
  responseHeaders.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const HEAD = proxy;
