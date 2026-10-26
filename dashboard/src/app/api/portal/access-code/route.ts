import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { control, parseSession, SESSION_COOKIE } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const jar = await cookies();
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Open the agent on this browser first." }, { status: 401 });
  const upstream = await control(`/tenants/${session.tenantId}/access-code`, {
    method: "POST",
    token: session.raw,
    body: {},
  });
  const accessCode = typeof upstream.data.accessCode === "string" ? upstream.data.accessCode : "";
  if (upstream.status !== 200 || !accessCode) {
    const error = typeof upstream.data.error === "string" ? upstream.data.error : "Could not create an access code.";
    return NextResponse.json({ error }, { status: upstream.status || 500 });
  }
  return NextResponse.json({ accessCode });
}
