import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { recoverAddress, restoreMessage } from "@/lib/eth-sig";
import { control, cookieBase, parseSession, SESSION_COOKIE } from "@/lib/portal-server";
import { getServerEnv } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const paymentTx = typeof body?.paymentTx === "string" ? body.paymentTx.trim().toLowerCase() : "";
  const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
  if (!/^0x[a-f0-9]{64}$/.test(paymentTx)) {
    return NextResponse.json({ error: "Paste the fee transaction hash." }, { status: 400 });
  }
  let payer = "";
  try {
    payer = recoverAddress(restoreMessage(paymentTx), signature);
  } catch {
    return NextResponse.json({ error: "The wallet signature could not be read." }, { status: 400 });
  }
  const secret = getServerEnv("CONTROL_API_SECRET");
  if (!secret) return NextResponse.json({ error: "Restore is not configured on this host." }, { status: 503 });
  const upstream = await control("/session/open", {
    method: "POST",
    token: secret,
    body: { paymentTx, payer },
  });
  const compound = typeof upstream.data.compoundToken === "string" ? upstream.data.compoundToken : "";
  if (upstream.status !== 200 || !parseSession(compound)) {
    const error = typeof upstream.data.error === "string" ? upstream.data.error : "Could not open that payment.";
    return NextResponse.json({ error }, { status: upstream.status || 401 });
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, compound, { ...cookieBase, maxAge: 60 * 60 * 24 * 30 });
  const payload = { ...upstream.data };
  delete payload.compoundToken;
  return NextResponse.json(payload);
}
