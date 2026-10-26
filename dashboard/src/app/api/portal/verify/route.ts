import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { recoverAddress } from "@/lib/eth-sig";
import { CHALLENGE_COOKIE, loginMessage, readChallenge } from "@/lib/portal-login";
import { control, portalCookie, ORDER_COOKIE, SESSION_COOKIE } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const paymentTx = typeof body?.paymentTx === "string" ? body.paymentTx.trim().toLowerCase() : "";
  const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
  const jar = await cookies();
  const challenge = readChallenge(jar.get(CHALLENGE_COOKIE)?.value);
  if (!challenge || challenge.purpose !== "payment" || challenge.paymentTx !== paymentTx) {
    return NextResponse.json({ error: "Confirm this payment in the wallet that sent it." }, { status: 401 });
  }
  let payer = "";
  try {
    payer = recoverAddress(loginMessage(challenge), signature);
  } catch {
    return NextResponse.json({ error: "The wallet signature could not be read." }, { status: 400 });
  }
  jar.delete(CHALLENGE_COOKIE);
  const raw = jar.get(ORDER_COOKIE)?.value;
  let order: { id?: string; secret?: string } = {};
  try {
    order = raw ? JSON.parse(raw) : {};
  } catch {
    order = {};
  }
  if (!order.id || !order.secret) {
    return NextResponse.json({ error: "Lock a quote in this browser first." }, { status: 409 });
  }
  const upstream = await control(`/checkout/${encodeURIComponent(order.id)}/verify`, {
    method: "POST",
    body: { paymentTx, claimSecret: order.secret, payer },
  });
  const compound = typeof upstream.data.compoundToken === "string" ? upstream.data.compoundToken : "";
  if (upstream.status === 200 && compound) {
    jar.set(SESSION_COOKIE, compound, { ...portalCookie(req), maxAge: 60 * 60 * 24 * 30 });
    jar.delete(ORDER_COOKIE);
  }
  const payload = { ...upstream.data };
  delete payload.compoundToken;
  delete payload.accessToken;
  return NextResponse.json(payload, { status: upstream.status });
}
