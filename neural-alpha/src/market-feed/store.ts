import type { MarketFeedSnapshot, MarketFeedStatus } from "./types.js";



let snapshot: MarketFeedSnapshot = emptySnapshot();



function emptySnapshot(): MarketFeedSnapshot {

  return {

    updatedAt: 0,

    fearGreed: null,

    trending: [],

    quotes: {},

    ohlcv: {},

    tokenIcons: {},

    meta: {

      quoteCount: 0,

      ohlcvCount: 0,

      trendingCount: 0,

      pollMs: 0,

    },

  };

}



export function getSnapshot(): MarketFeedSnapshot {

  return snapshot;

}



export function setSnapshot(next: MarketFeedSnapshot) {

  snapshot = next;

}



export function getStatus(): MarketFeedStatus {

  const ageMs = snapshot.updatedAt > 0 ? Date.now() - snapshot.updatedAt : -1;

  const pollMs = snapshot.meta.pollMs || 300_000;

  const stale = snapshot.updatedAt > 0 && ageMs > pollMs * 2;

  return {

    ok: snapshot.updatedAt > 0 && !stale,

    stale,

    updatedAt: snapshot.updatedAt,

    ageMs,

    quoteCount: snapshot.meta.quoteCount,

    ohlcvCount: snapshot.meta.ohlcvCount,

    trendingCount: snapshot.meta.trendingCount,

    fearGreed: snapshot.fearGreed,

    lastError: snapshot.meta.lastError,

  };

}

