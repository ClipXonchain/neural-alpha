import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { control, cookieBase, ORDER_COOKIE, SESSION_COOKIE } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const jar = await cookies();
  let saved: { id?: string; secret?: string } = {};
  try {
    saved = JSON.parse(jar.get(ORDER_COOKIE)?.value || "{}");
  } catch {
    saved = {};
  }
  const orderId = typeof saved.id === "string" ? saved.id : "";
  const claimSecret = typeof saved.secret === "string" ? saved.secret : "";
  if (!/^ord_[a-f0-9]{12}$/.test(orderId) || !/^[a-f0-9]{48}$/.test(claimSecret)) {
    return NextResponse.json({ error: "no active checkout" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  const status = await control(`/checkout/${encodeURIComponent(orderId)}`);
  if (status.status !== 200) {
    return NextResponse.json(status.data, { status: status.status, headers: { "cache-control": "no-store" } });
  }

  const order = status.data.order as { status?: string } | undefined;
  if (order?.status !== "paid") {
    return NextResponse.json({ order, activated: false }, { headers: { "cache-control": "no-store" } });
  }

  // The watcher can settle the order before the buyer submits a transaction
  // hash. Claim the one-time access token server-side using the HttpOnly order
  // cookie; never expose either token to browser JavaScript.
  const claimed = await control(`/checkout/${encodeURIComponent(orderId)}/claim`, {
    method: "POST",
    body: { claimSecret },
  });
  const compound = typeof claimed.data.compoundToken === "string" ? claimed.data.compoundToken : "";
  if (claimed.status === 200 && compound) {
    jar.set(SESSION_COOKIE, compound, { ...cookieBase, maxAge: 60 * 60 * 24 * 30 });
    jar.delete(ORDER_COOKIE);
  }
  const payload = { order, activated: Boolean(compound), tenant: claimed.data.tenant };
  return NextResponse.json(payload, {
    status: claimed.status === 200 ? 200 : claimed.status,
    headers: { "cache-control": "no-store" },
  });
}
