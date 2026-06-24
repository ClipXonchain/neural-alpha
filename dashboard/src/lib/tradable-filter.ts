/** Mirror of neural-alpha/src/config.ts tradability rules for dashboard filtering. */

export const DEFAULT_EXCLUDED = new Set([
  "NEX", "BTT", "SHIB", "AB", "BRETT", "NFT", "U", "HTX", "BDX", "RAY",
  "ZIL", "XCN", "BONK", "ROSE", "VELO", "LUNC", "NILA", "REAL", "FLOKI",
  "JUDAO", "BABYDOGE", "GOMINING", "XAUT",
]);

export const DEFAULT_MIN_TRADABLE_PRICE_USD = 0.01;

export function isScannableToken(
  symbol: string,
  price: number,
  opts?: { excluded?: string[]; minPriceUsd?: number }
): boolean {
  const upper = symbol.toUpperCase();
  const excluded = opts?.excluded?.length
    ? new Set(opts.excluded.map((s) => s.toUpperCase()))
    : DEFAULT_EXCLUDED;
  const minPrice = opts?.minPriceUsd ?? DEFAULT_MIN_TRADABLE_PRICE_USD;

  if (excluded.has(upper)) return false;
  if (price > 0 && price < minPrice) return false;
  return true;
}
