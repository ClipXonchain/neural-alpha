import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { CHALLENGE_COOKIE, loginMessage, packCookie, type Challenge } from "@/lib/portal-login";
import { portalCookie } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const purpose = body?.purpose === "payment" ? "payment" : body?.purpose === "login" ? "login" : "";
  if (!purpose) return NextResponse.json({ error: "Choose a wallet confirmation." }, { status: 400 });
  const paymentTx = purpose === "payment" ? String(body?.paymentTx || "").trim().toLowerCase() : "";
  if (purpose === "payment" && !/^0x[a-f0-9]{64}$/.test(paymentTx)) {
    return NextResponse.json({ error: "The hash must be 0x and 64 hex characters." }, { status: 400 });
  }
  const challenge: Challenge = {
    purpose,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + 5 * 60 * 1000,
    ...(paymentTx ? { paymentTx } : {}),
  };
  const jar = await cookies();
  jar.set(CHALLENGE_COOKIE, packCookie(challenge), { ...portalCookie(req), maxAge: 300 });
  return NextResponse.json({ message: loginMessage(challenge) });
}
