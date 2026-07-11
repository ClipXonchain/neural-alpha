import { NextRequest, NextResponse } from "next/server";
import { requireOwnerWallet } from "@/lib/session";
import {
  archiveAgent,
  assertAgentOwner,
  getAgent,
  stopAgent,
} from "@/lib/platform-registry";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const wallet = await requireOwnerWallet();
    const agent = await assertAgentOwner(id, wallet);
    const { api_secret_hash: _, ...safe } = agent;
    return NextResponse.json({ agent: safe });
  } catch (err) {
    const msg = String(err);
    const status = /Unauthorized/i.test(msg) ? 401 : /Forbidden/i.test(msg) ? 403 : 404;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const wallet = await requireOwnerWallet();
    const body = (await req.json().catch(() => ({}))) as { archive?: boolean };
    if (body.archive) {
      await archiveAgent(id, wallet);
    } else {
      await stopAgent(id, wallet);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = String(err);
    const status = /Unauthorized/i.test(msg) ? 401 : /Forbidden/i.test(msg) ? 403 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}

/** Public meta for a single agent (no secrets). */
export async function HEAD(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const agent = await getAgent(id);
  return new NextResponse(null, { status: agent ? 200 : 404 });
}
