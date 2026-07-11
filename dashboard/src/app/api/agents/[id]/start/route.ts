import { NextRequest, NextResponse } from "next/server";
import { requireOwnerWallet } from "@/lib/session";
import { startAgent } from "@/lib/platform-registry";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const wallet = await requireOwnerWallet();
    const result = await startAgent(id, wallet);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = String(err);
    const status = /Unauthorized/i.test(msg) ? 401 : /Forbidden/i.test(msg) ? 403 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
