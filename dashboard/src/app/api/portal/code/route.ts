import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { control, portalCookie, parseSession, SESSION_COOKIE } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) return NextResponse.json({ error: "Enter the access code." }, { status: 400 });
  const upstream = await control("/session/code", { method: "POST", body: { code } });
  const compound = typeof upstream.data.compoundToken === "string" ? upstream.data.compoundToken : "";
  if (upstream.status !== 200 || !parseSession(compound)) {
    const error = typeof upstream.data.error === "string" ? upstream.data.error : "That access code does not match an agent.";
    return NextResponse.json({ error }, { status: upstream.status || 401 });
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, compound, { ...portalCookie(req), maxAge: 60 * 60 * 24 * 30 });
  const payload = { ...upstream.data };
  delete payload.compoundToken;
  return NextResponse.json(payload);
}
