import { NextResponse } from "next/server";
import { listPublicAgents } from "@/lib/platform-registry";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const agents = await listPublicAgents(50);
    const publicList = agents.map((a) => ({
      id: a.id,
      displayName: a.display_name,
      tradingWallet: a.trading_wallet,
      status: a.status,
      erc8004AgentId: a.erc8004_agent_id,
      agentNumber: a.agent_number,
      deployedAt: a.deployed_at,
    }));
    return NextResponse.json({ agents: publicList });
  } catch (err) {
    return NextResponse.json({ agents: [], error: String(err) });
  }
}
