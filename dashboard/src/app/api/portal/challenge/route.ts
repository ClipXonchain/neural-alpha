import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { CHALLENGE_COOKIE, loginMessage, packCookie, type Challenge } from "@/lib/portal-login";
import { parseSession, portalCookie, SESSION_COOKIE } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const purpose = body?.purpose === "payment" ? "payment" : body?.purpose === "login" ? "login" : body?.purpose === "link" ? "link" : "";
  if (!purpose) return NextResponse.json({ error: "Choose a wallet confirmation." }, { status: 400 });
  const paymentTx = purpose === "payment" ? String(body?.paymentTx || "").trim().toLowerCase() : "";
  if (purpose === "payment" && !/^0x[a-f0-9]{64}$/.test(paymentTx)) {
    return NextResponse.json({ error: "The hash must be 0x and 64 hex characters." }, { status: 400 });
  }
  const jar = await cookies();
  // Linking is only offered to someone already signed in, and is bound to that one agent.
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  if (purpose === "link" && !session) {
    return NextResponse.json({ error: "Sign in to your agent first." }, { status: 401 });
  }
  const challenge: Challenge = {
    purpose,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + 5 * 60 * 1000,
    ...(paymentTx ? { paymentTx } : {}),
    ...(purpose === "link" && session ? { tenantId: session.tenantId } : {}),
  };
  jar.set(CHALLENGE_COOKIE, packCookie(challenge), { ...portalCookie(req), maxAge: 300 });
  return NextResponse.json({ message: loginMessage(challenge) });
}
