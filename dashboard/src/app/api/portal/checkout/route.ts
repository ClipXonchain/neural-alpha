import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { control, cookieBase, ORDER_COOKIE } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const upstream = await control("/checkout", { method: "POST", body });
  const order = upstream.data.order as { id?: string } | undefined;
  const claimSecret = typeof upstream.data.claimSecret === "string" ? upstream.data.claimSecret : "";
  if (upstream.status === 201 && order?.id && claimSecret) {
    const jar = await cookies();
    jar.set(ORDER_COOKIE, JSON.stringify({ id: order.id, secret: claimSecret }), {
      ...cookieBase,
      maxAge: 30 * 60,
    });
  }
  const payload = { ...upstream.data };
  delete payload.claimSecret;
  return NextResponse.json(payload, { status: upstream.status });
}
