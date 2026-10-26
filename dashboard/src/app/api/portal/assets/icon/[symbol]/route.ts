import { NextResponse } from "next/server";
import { portalAssetBytes } from "@/lib/binance-asset-icons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cache = new Map<string, { at: number; type: string; body: Buffer }>();
const CACHE_MS = 6 * 60 * 60 * 1000;

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await ctx.params;
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return new NextResponse(new Uint8Array(hit.body), {
      headers: { "content-type": hit.type, "cache-control": "public, max-age=86400" },
    });
  }
  const file = await portalAssetBytes(key);
  if (!file) return new NextResponse(null, { status: 404 });
  cache.set(key, { at: Date.now(), type: file.type, body: file.body });
  return new NextResponse(new Uint8Array(file.body), {
    headers: { "content-type": file.type, "cache-control": "public, max-age=86400" },
  });
}
