import { NextResponse } from "next/server";
import { requireOwnerWallet } from "@/lib/session";
import { listAgentsForOwner } from "@/lib/platform-registry";

export async function GET() {
  try {
    const wallet = await requireOwnerWallet();
    const agents = await listAgentsForOwner(wallet);
    // Never return api_secret_hash to client
    const safe = agents.map(({ api_secret_hash: _, ...rest }) => rest);
    return NextResponse.json({ agents: safe });
  } catch (err) {
    const msg = String(err);
    const status = /Unauthorized/i.test(msg) ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
