import { loadPriceHistory } from "../data/market.js";

import type { BinanceTrendingToken } from "../integrations/binance-web3-trending.js";

import { logger } from "../utils/logger.js";

import type { MarketData, PricePoint } from "../utils/types.js";

import type { MarketFeedSnapshot } from "./types.js";



const CLIENT_CACHE_MS = 15_000;

const MAX_FEED_AGE_MS = Math.max(

  120_000,

  parseInt(process.env.MARKET_FEED_MAX_AGE_MS || "600000", 10) || 600_000

);



let cached: { snap: MarketFeedSnapshot; fetchedAt: number } | null = null;



export function marketFeedUrl(): string | null {

  const raw = process.env.MARKET_FEED_URL?.trim();

  if (!raw) return null;

  return raw.replace(/\/$/, "");

}



export function isMarketFeedEnabled(): boolean {

  return marketFeedUrl() !== null;

}



async function fetchSnapshot(): Promise<MarketFeedSnapshot | null> {

  const base = marketFeedUrl();

  if (!base) return null;



  if (

    cached &&

    Date.now() - cached.fetchedAt < CLIENT_CACHE_MS &&

    cached.snap.updatedAt > 0

  ) {

    return cached.snap;

  }



  try {

    const res = await fetch(`${base}/snapshot`, {

      headers: { Accept: "application/json" },

      signal: AbortSignal.timeout(8_000),

    });

    if (!res.ok) {

      logger.warn("Market feed snapshot HTTP error", { status: res.status });

      return cached?.snap ?? null;

    }

    const snap = (await res.json()) as MarketFeedSnapshot;

    if (!snap?.updatedAt) return cached?.snap ?? null;

    const ageMs = Date.now() - snap.updatedAt;

    if (ageMs > MAX_FEED_AGE_MS) {

      logger.warn("Market feed snapshot too stale for trading", { ageMs, max: MAX_FEED_AGE_MS });

      return null;

    }

    cached = { snap, fetchedAt: Date.now() };

    return snap;

  } catch (err) {

    logger.warn("Market feed unreachable — falling back to direct APIs", {

      error: String(err),

      url: base,

    });

    return cached?.snap ?? null;

  }

}



export interface FeedApplyResult {

  used: boolean;

  markets: MarketData[];

  fearGreed: number | null;

  trending: BinanceTrendingToken[];

  ohlcvLoaded: string[];

  tokenIcons: Record<string, string>;

  updatedAt: number;

}



/**

 * Pull shared snapshot and hydrate local candle history.

 * Returns null when feed is disabled or unavailable (caller uses direct APIs).

 */

export async function pullMarketFeed(opts: {

  /** Symbols the agent cares about (watchlist + positions). Empty = all quotes. */

  symbols?: string[];

  fullScan?: boolean;

} = {}): Promise<FeedApplyResult | null> {

  if (!isMarketFeedEnabled()) return null;



  const snap = await fetchSnapshot();

  if (!snap) return null;



  const focus = new Set(

    (opts.symbols ?? []).map((s) => s.toUpperCase()).filter(Boolean)

  );

  const takeAll = !!opts.fullScan || focus.size === 0;



  const markets: MarketData[] = [];

  for (const [symbol, md] of Object.entries(snap.quotes)) {

    if (!takeAll && !focus.has(symbol)) continue;

    markets.push({ ...md, timestamp: snap.updatedAt });

  }



  // Always include trending symbols that have quotes

  for (const t of snap.trending) {

    const md = snap.quotes[t.symbol];

    if (md && !markets.some((m) => m.symbol === t.symbol)) {

      markets.push({ ...md, timestamp: snap.updatedAt });

    }

  }



  const loadSymbols = new Set([

    ...markets.map((m) => m.symbol),

    ...focus,

  ]);



  const ohlcvLoaded: string[] = [];

  for (const symbol of loadSymbols) {

    const points = snap.ohlcv[symbol];

    if (!Array.isArray(points) || points.length < 14) continue;

    loadPriceHistory(symbol, points as PricePoint[], { fromKlines: true });

    ohlcvLoaded.push(symbol);

  }



  logger.info("Market feed applied", {

    markets: markets.length,

    ohlcv: ohlcvLoaded.length,

    trending: snap.trending.length,

    fearGreed: snap.fearGreed,

    ageMs: Date.now() - snap.updatedAt,

  });



  return {

    used: true,

    markets,

    fearGreed: snap.fearGreed,

    trending: snap.trending,

    ohlcvLoaded,

    tokenIcons: snap.tokenIcons ?? {},

    updatedAt: snap.updatedAt,

  };

}

