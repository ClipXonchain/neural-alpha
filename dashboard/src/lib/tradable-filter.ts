/** Mirror of neural-alpha/src/config.ts tradability rules for dashboard filtering. */

/** Mega-cap tokens excluded from scans/signals (CMC top-rank class). */
export const HIGH_MCAP_EXCLUDED = new Set([
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX", "LINK", "AVAX",
  "DOT", "TON", "LTC", "BCH", "UNI", "ETC", "ATOM", "FIL", "SHIB", "HYPE",
  "ZEC", "NEAR", "APT", "SUI", "ARB", "OP", "POL", "MATIC", "ICP", "STX",
  "HBAR", "VET", "XLM", "ALGO", "EOS", "TAO", "RENDER", "QNT", "MKR",
]);

export const DEFAULT_EXCLUDED = new Set([
  ...HIGH_MCAP_EXCLUDED,
  "NEX", "BTT", "AB", "BRETT", "NFT", "U", "HTX", "BDX", "RAY",
  "ZIL", "XCN", "BONK", "ROSE", "VELO", "LUNC", "NILA", "REAL", "FLOKI",
  "JUDAO", "BABYDOGE", "GOMINING", "XAUT",
]);

/** Crypto tickers ending in ON that are not Ondo tokenized stocks. */
const TOKENIZED_STOCK_SYMBOL_EXCEPTIONS = new Set([
  "ON", "SOON", "ELON", "TYCOON", "COMMON", "RION", "AGON", "TON", "TRON", "ICON",
]);

/** Ondo / tokenized stock-ETF tickers on Binance Alpha (TSLAon, VRTon, …). */
export function isTokenizedStockOrEtf(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  if (TOKENIZED_STOCK_SYMBOL_EXCEPTIONS.has(upper)) return false;
  return upper.length >= 4 && upper.endsWith("ON");
}

export const DEFAULT_MIN_TRADABLE_PRICE_USD = 0.01;

export const DEFAULT_MAX_TRADABLE_MARKET_CAP_USD = 10_000_000_000;

export function isScannableToken(
  symbol: string,
  price: number,
  opts?: {
    excluded?: string[];
    minPriceUsd?: number;
    maxMarketCapUsd?: number;
    marketCapUsd?: number;
  }
): boolean {
  const upper = symbol.toUpperCase();
  const excluded = opts?.excluded?.length
    ? new Set(opts.excluded.map((s) => s.toUpperCase()))
    : DEFAULT_EXCLUDED;
  const minPrice = opts?.minPriceUsd ?? DEFAULT_MIN_TRADABLE_PRICE_USD;
  const maxMcap = opts?.maxMarketCapUsd ?? DEFAULT_MAX_TRADABLE_MARKET_CAP_USD;

  if (excluded.has(upper)) return false;
  if (isTokenizedStockOrEtf(upper)) return false;
  if (price > 0 && price < minPrice) return false;
  if (
    opts?.marketCapUsd != null &&
    opts.marketCapUsd > 0 &&
    maxMcap > 0 &&
    opts.marketCapUsd >= maxMcap
  ) {
    return false;
  }
  return true;
}
