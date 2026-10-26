import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { control, parseSession, SESSION_COOKIE } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const jar = await cookies();
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "no agent on this browser" }, { status: 401 });
  const [info, live] = await Promise.all([
    control(`/tenants/${session.tenantId}`, { token: session.raw }),
    control(`/tenants/${session.tenantId}/state`, { token: session.raw }),
  ]);
  if (info.status !== 200) {
    return NextResponse.json({ error: "this browser's agent is no longer valid" }, { status: info.status });
  }
  return NextResponse.json({ tenant: info.data.tenant, state: live.status === 200 ? live.data.state : null });
}
