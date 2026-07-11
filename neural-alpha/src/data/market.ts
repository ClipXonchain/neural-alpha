import { logger } from "../utils/logger.js";
import type { MarketData, PricePoint } from "../utils/types.js";
import { BSC_CHAIN } from "../config.js";
import { recordMarketCap } from "./market-cap-cache.js";

/**
 * Market data provider that uses CMC Agent Hub via x402 pay-per-request
 * and TWAK price feeds as fallback. All CMC data flows through x402
 * to satisfy the "Best Use of Agent Hub" special prize criteria.
 *
 * In the live agent loop, this module is called via MCP tool invocations
 * from the orchestrating AI agent. The functions below are used when
 * running the agent as a standalone process (non-MCP mode).
 */

const CMC_X402_BASE = process.env.CMC_X402_BASE_URL || "https://agenthub.coinmarketcap.com";

const priceHistory: Map<string, PricePoint[]> = new Map();
/** Symbols whose candle history came from Binance klines (not synthetic seed). */
const realOhlcvSymbols = new Set<string>();
const MAX_HISTORY_LENGTH = 200;

export function recordPrice(
  symbol: string,
  price: number,
  volume?: number,
  marketCap?: number
) {
  if (marketCap != null && marketCap > 0) {
    recordMarketCap(symbol, marketCap);
  }
  const now = Date.now();
  if (!priceHistory.has(symbol)) {
    priceHistory.set(symbol, []);
  }
  const history = priceHistory.get(symbol)!;
  const point: PricePoint = {
    timestamp: now,
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
  };

  if (history.length > 0) {
    const last = history[history.length - 1];
    const timeDiff = now - last.timestamp;
    // Merge into same candle if within 5 minutes
    if (timeDiff < 300_000) {
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      if (volume !== undefined) last.volume = (last.volume || 0) + volume;
      return;
    }
  }

  history.push(point);
  if (history.length > MAX_HISTORY_LENGTH) {
    history.shift();
  }
}

export function getPriceHistory(symbol: string): PricePoint[] {
  return priceHistory.get(symbol) || [];
}

export function getLatestPrice(symbol: string): number | null {
  const history = priceHistory.get(symbol);
  if (!history || history.length === 0) return null;
  return history[history.length - 1].close;
}

export function getClosePrices(symbol: string): number[] {
  const history = priceHistory.get(symbol);
  if (!history) return [];
  return history.map((p) => p.close);
}

export function getVolumes(symbol: string): number[] {
  const history = priceHistory.get(symbol);
  if (!history) return [];
  return history.map((p) => p.volume || 0);
}

/** Replace in-memory candle history (e.g. from Binance klines). */
export function loadPriceHistory(
  symbol: string,
  points: PricePoint[],
  opts?: { fromKlines?: boolean }
) {
  if (points.length === 0) return;
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
  priceHistory.set(symbol, sorted.slice(-MAX_HISTORY_LENGTH));
  if (opts?.fromKlines) {
    realOhlcvSymbols.add(symbol.toUpperCase());
  }
}

/** Age of the newest candle in ms; null if no history. */
export function getHistoryAgeMs(symbol: string): number | null {
  const history = priceHistory.get(symbol);
  if (!history || history.length === 0) return null;
  return Date.now() - history[history.length - 1].timestamp;
}

/** True when history has enough Binance kline candles for RSI/MACD. */
export function hasRealHistory(symbol: string, minPoints = 14): boolean {
  const sym = symbol.toUpperCase();
  if (!realOhlcvSymbols.has(sym)) return false;
  return getHistoryLength(sym) >= minPoints;
}

export function buildMarketData(
  symbol: string,
  price: number,
  extras?: Partial<MarketData>
): MarketData {
  recordPrice(symbol, price, extras?.volume24h, extras?.marketCap);
  return {
    symbol,
    price,
    timestamp: Date.now(),
    ...extras,
  };
}

/**
 * CMC x402 endpoint URLs for different data types.
 * These are called via TWAK's x402_request MCP tool, which handles
 * the payment flow (402 challenge → sign → retry with X-Payment header).
 */
export const CMC_ENDPOINTS = {
  price: (symbol: string) =>
    `${CMC_X402_BASE}/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(symbol)}`,
  /** Batch quotes — one x402 payment for many symbols (CMC Agent Hub). */
  quotes: (symbols: string[]) =>
    `${CMC_X402_BASE}/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(symbols.join(","))}`,
  fearGreed: () =>
    `${CMC_X402_BASE}/v1/global-metrics/fear-and-greed`,
  trending: () =>
    `${CMC_X402_BASE}/v1/cryptocurrency/trending/latest`,
  listings: (limit = 100) =>
    `${CMC_X402_BASE}/v1/cryptocurrency/listings/latest?limit=${limit}`,
  /** OHLCV historical candles (CMC Agent Hub x402). */
  ohlcv: (symbol: string, interval = "5m", count = 100) =>
    `${CMC_X402_BASE}/v1/cryptocurrency/ohlcv/historical?symbol=${encodeURIComponent(symbol)}&time_period=hourly&interval=${interval}&count=${count}`,
  metadata: (symbol: string) =>
    `${CMC_X402_BASE}/v1/cryptocurrency/info?symbol=${symbol}`,
  socialBuzz: (symbol: string) =>
    `${CMC_X402_BASE}/v1/cryptocurrency/social?symbol=${symbol}`,
} as const;

/**
 * Parse CMC x402 response data into our MarketData format.
 */
export function parseCmcQuote(raw: Record<string, unknown>, symbol: string): MarketData | null {
  try {
    const data = raw as Record<string, Record<string, unknown>>;
    const quote = data?.data?.[symbol] as Record<string, unknown> | undefined;
    if (!quote) return null;

    const usd = (quote as Record<string, Record<string, unknown>>)?.quote?.USD as Record<string, number> | undefined;
    if (!usd) return null;

    return buildMarketData(symbol, usd.price, {
      change24h: usd.percent_change_24h,
      volume24h: usd.volume_24h,
      marketCap: usd.market_cap,
    });
  } catch (e) {
    logger.error("Failed to parse CMC quote", { symbol, error: String(e) });
    return null;
  }
}

export function parseFearGreedIndex(raw: Record<string, unknown>): number | null {
  try {
    const payload = raw?.data;
    if (payload && typeof payload === "object") {
      if (Array.isArray(payload)) {
        const first = payload[0] as Record<string, unknown> | undefined;
        const v = first?.value;
        if (typeof v === "number") return v;
      } else {
        const v = (payload as Record<string, unknown>).value;
        if (typeof v === "number") return v;
      }
    }
    const top = raw?.value;
    return typeof top === "number" ? top : null;
  } catch {
    return null;
  }
}

/**
 * Unwrap TWAK x402_request tool output into parsed JSON body.
 * Handles direct JSON, nested `data`, string `body`, and MCP text payloads.
 */
export function unwrapX402Response(
  raw: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!raw) return null;

  if (typeof raw.body === "string") {
    try {
      return JSON.parse(raw.body) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  if (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) {
    const inner = raw.data as Record<string, unknown>;
    if (inner.data !== undefined || inner.status !== undefined) {
      return inner;
    }
  }

  if (raw.response && typeof raw.response === "object") {
    return raw.response as Record<string, unknown>;
  }

  return raw;
}

/**
 * Parse CMC trending/latest x402 response into eligible symbol list.
 */
export function parseCmcTrending(
  raw: Record<string, unknown> | null
): Array<{ symbol: string }> | null {
  if (!raw) return null;
  try {
    const items = raw.data;
    if (!Array.isArray(items)) return null;
    return items
      .map((item) => {
        const row = item as Record<string, unknown>;
        const symbol = (row.symbol || row.ticker) as string | undefined;
        return symbol ? { symbol: symbol.toUpperCase() } : null;
      })
      .filter((x): x is { symbol: string } => x !== null);
  } catch (e) {
    logger.error("Failed to parse CMC trending", { error: String(e) });
    return null;
  }
}

/**
 * Parse batch CMC quotes response into MarketData map.
 */
export function parseCmcQuotesBatch(
  raw: Record<string, unknown> | null,
  symbols: string[]
): Map<string, MarketData> {
  const out = new Map<string, MarketData>();
  if (!raw) return out;

  for (const symbol of symbols) {
    const parsed = parseCmcQuote(raw, symbol);
    if (parsed) out.set(symbol, parsed);
  }
  return out;
}

/**
 * Pre-seed synthetic candle history for a token so technical indicators
 * (RSI, MACD, Bollinger, etc.) can produce signals from cycle 1.
 * Generates `count` candles working backwards from `currentPrice` using
 * a random-walk with configurable volatility.
 */
export function seedPriceHistory(
  symbol: string,
  currentPrice: number,
  count = 50,
  volatilityPct = 2
) {
  if (priceHistory.has(symbol) && priceHistory.get(symbol)!.length >= count) {
    return; // already seeded
  }

  const now = Date.now();
  const intervalMs = 300_000; // 5-minute candles
  const points: PricePoint[] = [];

  let price = currentPrice * (1 + (Math.random() - 0.5) * 0.15);

  for (let i = count; i >= 1; i--) {
    const change = (Math.random() - 0.48) * (volatilityPct / 100); // slight upward bias
    price = price * (1 + change);

    const intraVol = price * (volatilityPct / 200);
    const open = price + (Math.random() - 0.5) * intraVol;
    const close = price;
    const high = Math.max(open, close) + Math.random() * intraVol;
    const low = Math.min(open, close) - Math.random() * intraVol;
    const volume = 50000 + Math.random() * 200000;

    points.push({
      timestamp: now - i * intervalMs,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  priceHistory.set(symbol, points);
}

/**
 * Return the number of data points available for a symbol.
 */
export function getHistoryLength(symbol: string): number {
  return priceHistory.get(symbol)?.length ?? 0;
}
