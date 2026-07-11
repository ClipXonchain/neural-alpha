import { NextResponse } from "next/server";
import { isTokenizedStockOrEtf } from "@/lib/tradable-filter";
import { normalizeTokenIconUrl } from "@/lib/utils";

const ALPHA_LIST_URL =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";

/** Runtime-only — avoids blocking `next build` on Binance API (can hang on some VPS regions). */
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, s-maxage=21600, stale-while-revalidate=3600";

export async function GET() {
  try {
    const res = await fetch(ALPHA_LIST_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { symbols: [], icons: {}, error: `HTTP ${res.status}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    const body = (await res.json()) as { data?: Record<string, unknown>[] };
    const rows = Array.isArray(body.data) ? body.data : [];
    const seen = new Set<string>();
    const symbols: string[] = [];
    const icons: Record<string, string> = {};

    for (const row of rows) {
      if (String(row.chainId) !== "56") continue;
      if (row.offline === true || row.fullyDelisted === true) continue;
      const sym = String(row.symbol ?? "").trim().toUpperCase();
      const name = row.name ? String(row.name) : undefined;
      if (!sym || seen.has(sym)) continue;
      if (isTokenizedStockOrEtf(sym)) continue;
      if (name && /\(ondo\)|tokenized (stock|etf|security)/i.test(name)) continue;
      seen.add(sym);
      symbols.push(sym);
      const iconUrl = row.iconUrl ? String(row.iconUrl) : undefined;
      const normalized = normalizeTokenIconUrl(iconUrl);
      if (normalized) icons[sym] = normalized;
    }

    symbols.sort();
    return NextResponse.json(
      {
        symbols,
        icons,
        count: symbols.length,
        source: "binance-alpha-api",
        chain: "BSC",
      },
      { headers: { "Cache-Control": CACHE_CONTROL } }
    );
  } catch (err) {
    return NextResponse.json(
      { symbols: [], icons: {}, error: String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
