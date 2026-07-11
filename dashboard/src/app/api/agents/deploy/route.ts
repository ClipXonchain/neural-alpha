import { NextRequest, NextResponse } from "next/server";
import { requireOwnerWallet } from "@/lib/session";
import {
  getDeployFeeBnb,
  provisionAgent,
  shouldSkipDeployFee,
} from "@/lib/platform-registry";
import { getServerEnv } from "@/lib/server-env";

export async function GET() {
  return NextResponse.json({
    feeBnb: getDeployFeeBnb(),
    treasury: getServerEnv("PLATFORM_TREASURY_ADDRESS") || null,
    skipFee: shouldSkipDeployFee(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const wallet = await requireOwnerWallet();
    const body = (await req.json()) as {
      displayName?: string;
      feeTxHash?: string;
      agentUniverse?: string;
    };

    const feeTxHash =
      body.feeTxHash ||
      (shouldSkipDeployFee() ? `0x${"0".repeat(64)}` : "");

    if (!feeTxHash || !/^0x[a-fA-F0-9]{64}$/.test(feeTxHash)) {
      return NextResponse.json(
        { error: "feeTxHash required (BNB transfer to treasury)" },
        { status: 400 }
      );
    }

    const universeRaw = (body.agentUniverse || "both").trim().toLowerCase();
    if (!["spot", "alpha", "both", "bstocks"].includes(universeRaw)) {
      return NextResponse.json(
        { error: "agentUniverse must be spot, alpha, both, or bstocks" },
        { status: 400 }
      );
    }

    const { agent, apiSecret, mnemonic } = await provisionAgent({
      ownerWallet: wallet,
      displayName: body.displayName?.trim() || `Agent ${Date.now()}`,
      feeTxHash,
      agentUniverse: universeRaw as "spot" | "alpha" | "both" | "bstocks",
    });

    const { api_secret_hash: _, ...safe } = agent;
    // Return secrets once — mnemonic is never stored in DB / never shown again unless owner re-exports
    return NextResponse.json({
      ok: true,
      agent: safe,
      apiSecret,
      mnemonic,
      fundInstructions: {
        tradingWallet: agent.trading_wallet,
        message:
          "Send USDT (BSC) to the trading wallet for capital, and a little BNB for gas. Write down your seed phrase before leaving this page.",
      },
    });
  } catch (err) {
    const msg = String(err);
    const status = /Unauthorized/i.test(msg) ? 401 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
