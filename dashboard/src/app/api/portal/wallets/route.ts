import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { recoverAddress } from "@/lib/eth-sig";
import { CHALLENGE_COOKIE, loginMessage, readChallenge } from "@/lib/portal-login";
import { control, parseSession, SESSION_COOKIE } from "@/lib/portal-server";
import { getServerEnv } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Links a browser wallet as a way to sign in. The wallet only signs a message: no funds, no trading. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
  const jar = await cookies();
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Sign in to your agent first." }, { status: 401 });
  const challenge = readChallenge(jar.get(CHALLENGE_COOKIE)?.value);
  if (!challenge || challenge.purpose !== "link" || challenge.tenantId !== session.tenantId) {
    return NextResponse.json({ error: "The wallet confirmation expired. Start again." }, { status: 401 });
  }
  let address = "";
  try {
    address = recoverAddress(loginMessage(challenge), signature);
  } catch {
    return NextResponse.json({ error: "The wallet signature could not be read." }, { status: 400 });
  }
  jar.delete(CHALLENGE_COOKIE);
  const secret = getServerEnv("CONTROL_API_SECRET");
  if (!secret) return NextResponse.json({ error: "Wallet sign-in is not configured on this host." }, { status: 503 });
  // The signature is checked here, so the control plane accepts the address from the portal only.
  const upstream = await control(`/tenants/${session.tenantId}/wallets`, { method: "POST", token: secret, body: { address } });
  return NextResponse.json(upstream.data, { status: upstream.status });
}

export async function DELETE(req: Request) {
  const body = await req.json().catch(() => null);
  const address = typeof body?.address === "string" ? body.address.trim().toLowerCase() : "";
  if (!/^0x[a-f0-9]{40}$/.test(address)) return NextResponse.json({ error: "Choose one of your wallets." }, { status: 400 });
  const jar = await cookies();
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Sign in to your agent first." }, { status: 401 });
  const upstream = await control(`/tenants/${session.tenantId}/wallets/${address}`, { method: "DELETE", token: session.raw });
  return NextResponse.json(upstream.data, { status: upstream.status });
}
