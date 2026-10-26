import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { recoverAddress } from "@/lib/eth-sig";
import {
  CHALLENGE_COOKIE,
  PROOF_COOKIE,
  loginMessage,
  readChallenge,
  sealPayer,
} from "@/lib/portal-login";
import { control, portalCookie, parseSession, SESSION_COOKIE } from "@/lib/portal-server";
import { getServerEnv } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicAgents(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    if (!/^[a-f0-9]{8}$/.test(id)) return [];
    return [
      {
        id,
        container_name: typeof item.container_name === "string" ? item.container_name : null,
        payment_asset: typeof item.payment_asset === "string" ? item.payment_asset : null,
        paid_until: typeof item.paid_until === "string" ? item.paid_until : null,
        status: typeof item.status === "string" ? item.status : null,
      },
    ];
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
  const jar = await cookies();
  const challenge = readChallenge(jar.get(CHALLENGE_COOKIE)?.value);
  if (!challenge || challenge.purpose !== "login") {
    return NextResponse.json({ error: "The wallet confirmation expired. Start again." }, { status: 401 });
  }
  let payer = "";
  try {
    payer = recoverAddress(loginMessage(challenge), signature);
  } catch {
    return NextResponse.json({ error: "The wallet signature could not be read." }, { status: 400 });
  }
  jar.delete(CHALLENGE_COOKIE);
  const secret = getServerEnv("CONTROL_API_SECRET");
  if (!secret) return NextResponse.json({ error: "Restore is not configured on this host." }, { status: 503 });
  const upstream = await control("/session/open", {
    method: "POST",
    token: secret,
    body: { payer },
  });
  const agents = publicAgents(upstream.data.agents);
  if (agents.length > 1) {
    jar.set(PROOF_COOKIE, sealPayer(payer, secret), { ...portalCookie(req), maxAge: 600 });
    return NextResponse.json({ agents });
  }
  const compound = typeof upstream.data.compoundToken === "string" ? upstream.data.compoundToken : "";
  if (upstream.status !== 200 || !parseSession(compound)) {
    const error = typeof upstream.data.error === "string" ? upstream.data.error : "This wallet has not paid for an agent.";
    return NextResponse.json({ error }, { status: upstream.status || 401 });
  }
  jar.set(SESSION_COOKIE, compound, { ...portalCookie(req), maxAge: 60 * 60 * 24 * 30 });
  const payload = { ...upstream.data };
  delete payload.compoundToken;
  return NextResponse.json(payload);
}
