import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { openPayer, PROOF_COOKIE } from "@/lib/portal-login";
import { control, portalCookie, parseSession, SESSION_COOKIE } from "@/lib/portal-server";
import { getServerEnv } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const tenantId = typeof body?.tenantId === "string" ? body.tenantId.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{8}$/.test(tenantId)) {
    return NextResponse.json({ error: "Choose one of your agents." }, { status: 400 });
  }
  const secret = getServerEnv("CONTROL_API_SECRET");
  if (!secret) return NextResponse.json({ error: "Restore is not configured on this host." }, { status: 503 });
  const jar = await cookies();
  const payer = openPayer(jar.get(PROOF_COOKIE)?.value, secret);
  if (!payer) return NextResponse.json({ error: "Confirm the paying wallet again." }, { status: 401 });
  const upstream = await control("/session/open", {
    method: "POST",
    token: secret,
    body: { payer, tenantId },
  });
  const compound = typeof upstream.data.compoundToken === "string" ? upstream.data.compoundToken : "";
  if (upstream.status !== 200 || !parseSession(compound)) {
    const error = typeof upstream.data.error === "string" ? upstream.data.error : "That agent is not paid by this wallet.";
    return NextResponse.json({ error }, { status: upstream.status || 401 });
  }
  jar.set(SESSION_COOKIE, compound, { ...portalCookie(req), maxAge: 60 * 60 * 24 * 30 });
  jar.delete(PROOF_COOKIE);
  const payload = { ...upstream.data };
  delete payload.compoundToken;
  return NextResponse.json(payload);
}
