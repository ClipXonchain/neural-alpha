/** Latest market cap per symbol (USD) — updated from CMC / market-feed quotes. */

const latestMarketCaps = new Map<string, number>();

export function recordMarketCap(symbol: string, marketCap: number): void {
  if (!Number.isFinite(marketCap) || marketCap <= 0) return;
  latestMarketCaps.set(symbol.toUpperCase(), marketCap);
}

export function getMarketCap(symbol: string): number | null {
  return latestMarketCaps.get(symbol.toUpperCase()) ?? null;
}
