import { NextResponse } from "next/server";
import { portalAssets } from "@/lib/binance-asset-icons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const assets = await portalAssets();
  return NextResponse.json(
    { assets },
    { headers: { "cache-control": "no-store" } },
  );
}
