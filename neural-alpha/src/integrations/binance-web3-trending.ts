import { isEligibleToken, isStablecoin, isTradableToken } from "../config.js";
import { BSC_CHAIN_ID } from "./binance-web3-wallet.js";
import { logger } from "../utils/logger.js";

const TRENDING_URL =
  "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/unified/rank/list/ai";

const DEFAULT_HEADERS = {
  clienttype: "web",
  clientversion: "1.2.0",
  "Content-Type": "application/json",
  "User-Agent": "binance-web3/2.0 (NeuralAlpha)",
};

/** rankType 10 = Trending; period 20 = 5m; sortBy 50 = price change (%). */
const DEFAULT_BODY = {
  rankType: 10,
  chainId: String(BSC_CHAIN_ID),
  period: 20,
  sortBy: 50,
  orderAsc: false,
  page: 1,
  size: 200,
};

export interface BinanceTrendingToken {
  symbol: string;
  rank: number;
  percentChange5m: number;
  percentChange24h: number;
  contractAddress: string;
  price: number;
}

const CACHE_MS = Math.max(
  60_000,
  parseInt(process.env.BINANCE_TRENDING_CACHE_MS || "300000", 10) || 300_000
);

let cached: { tokens: BinanceTrendingToken[]; fetchedAt: number } | null = null;

function parseNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

/** Binance Spot ∪ Binance Alpha only — excludes mega-caps and off-list tokens. */
export function isAllowedTrendingSymbol(symbol: string, price?: number): boolean {
  const upper = symbol.toUpperCase();
  return (
    isEligibleToken(upper) &&
    !isStablecoin(upper) &&
    isTradableToken(upper, price)
  );
}

function filterEligibleTrending(
  rows: Array<Record<string, unknown>>,
  limit: number
): BinanceTrendingToken[] {
  const tokens: BinanceTrendingToken[] = [];
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").toUpperCase().trim();
    if (!symbol || !isAllowedTrendingSymbol(symbol, parseNum(row.price))) continue;
    tokens.push({
      symbol,
      rank: tokens.length + 1,
      percentChange5m: parseNum(row.percentChange5m),
      percentChange24h: parseNum(row.percentChange24h),
      contractAddress: String(row.contractAddress ?? ""),
      price: parseNum(row.price),
    });
    if (tokens.length >= limit) break;
  }
  return tokens;
}

/**
 * Fetch BSC trending tokens from Binance Web3 (5m window, sorted by % change).
 * Only returns Binance Spot ∪ Alpha tokens — never random off-list BSC memes.
 */
export async function fetchBinanceWeb3Trending(
  opts: { limit?: number; force?: boolean } = {}
): Promise<BinanceTrendingToken[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  if (
    !opts.force &&
    cached &&
    Date.now() - cached.fetchedAt < CACHE_MS &&
    cached.tokens.length > 0
  ) {
    return cached.tokens.slice(0, limit);
  }

  try {
    const res = await fetch(TRENDING_URL, {
      method: "POST",
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({ ...DEFAULT_BODY, size: 200 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn("Binance Web3 trending HTTP error", { status: res.status });
      return cached?.tokens.slice(0, limit) ?? [];
    }

    const json = (await res.json()) as {
      code?: string;
      data?: { tokens?: Array<Record<string, unknown>> };
    };
    if (json.code !== "000000" || !Array.isArray(json.data?.tokens)) {
      logger.warn("Binance Web3 trending bad response", { code: json.code });
      return cached?.tokens.slice(0, limit) ?? [];
    }

    const tokens = filterEligibleTrending(json.data.tokens, limit);

    if (tokens.length > 0) {
      cached = { tokens, fetchedAt: Date.now() };
      logger.info("Binance Web3 trending fetched (Spot/Alpha only)", {
        count: tokens.length,
        top: tokens
          .slice(0, 5)
          .map((t) => `${t.symbol}#${t.rank}(5m ${t.percentChange5m.toFixed(1)}%)`),
      });
    }

    return tokens;
  } catch (err) {
    logger.warn("Binance Web3 trending fetch failed", { error: String(err) });
    return cached?.tokens.slice(0, limit) ?? [];
  }
}

export function trendingToSymbolList(
  tokens: BinanceTrendingToken[]
): Array<{ symbol: string }> {
  return tokens.map((t) => ({ symbol: t.symbol }));
}

export function filterTrendingSymbols(
  symbols: Array<{ symbol: string }>
): Array<{ symbol: string }> {
  return symbols.filter((t) => isAllowedTrendingSymbol(t.symbol));
}
