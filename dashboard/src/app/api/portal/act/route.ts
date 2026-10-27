import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { control, parseSession, SESSION_COOKIE } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPS: Record<string, { method: "GET" | "POST"; path: string }> = {
  pause: { method: "POST", path: "/pause" },
  resume: { method: "POST", path: "/resume" },
  risk: { method: "POST", path: "/risk" },
  mode: { method: "POST", path: "/mode" },
  signals: { method: "POST", path: "/signals" },
  "pair-start": { method: "POST", path: "/pair/start" },
  "pair-verify": { method: "POST", path: "/pair/verify" },
};

export async function POST(req: Request) {
  const jar = await cookies();
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "no agent on this browser" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const op = OPS[String(body?.op || "")];
  if (!op) return NextResponse.json({ error: "unknown action" }, { status: 404 });
  const upstream = await control(`/tenants/${session.tenantId}${op.path}`, {
    method: op.method,
    token: session.raw,
    body: op.method === "POST" ? body?.body || {} : undefined,
  });
  return NextResponse.json(upstream.data, { status: upstream.status });
}
