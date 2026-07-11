import type { MarketData, PricePoint } from "../utils/types.js";

import type { BinanceTrendingToken } from "../integrations/binance-web3-trending.js";



/** Shared market snapshot — one producer, many agent consumers. */

export interface MarketFeedSnapshot {

  updatedAt: number;

  fearGreed: number | null;

  /** Binance Web3 BSC trending (1h window, sorted by % change). */

  trending: BinanceTrendingToken[];

  quotes: Record<string, MarketData>;

  ohlcv: Record<string, PricePoint[]>;

  /** Binance CDN token logos (Alpha API + Web3 meta). */
  tokenIcons: Record<string, string>;

  meta: {

    quoteCount: number;

    ohlcvCount: number;

    trendingCount: number;

    pollMs: number;

    lastError?: string;

    /** True when quotes were copied from the previous snapshot (CMC/API failure). */
    quotesStale?: boolean;

  };

}



export interface MarketFeedStatus {

  ok: boolean;

  stale?: boolean;

  updatedAt: number;

  ageMs: number;

  quoteCount: number;

  ohlcvCount: number;

  trendingCount: number;

  fearGreed: number | null;

  lastError?: string;

}

