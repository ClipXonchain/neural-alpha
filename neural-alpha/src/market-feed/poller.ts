import {
  getEligibleScanUniverse,
  FULL_SCAN_BATCH_SIZE,
  isStablecoin,
} from "../config.js";
import {
  fetchTokenKlines,
  fetchTokenDynamic,
  buildTokenIconMap,
} from "../integrations/binance-web3-market.js";
import {
  refreshBinanceAlphaTokens,
  getBinanceAlphaIcon,
} from "../integrations/binance-alpha-tokens.js";
import { getBstocksSymbols } from "../integrations/bstocks-tokens.js";
import {
  parseCmcQuotesBatch,
  parseFearGreedIndex,
} from "../data/market.js";
import { fetchBinanceWeb3Trending } from "../integrations/binance-web3-trending.js";
import { knownBscAddress } from "../integrations/bsc-token-addresses.js";
import { logger } from "../utils/logger.js";
import type { MarketData, PricePoint } from "../utils/types.js";
import { getSnapshot, setSnapshot } from "./store.js";
import type { MarketFeedSnapshot } from "./types.js";

const CMC_PRO_BASE =
  process.env.CMC_PRO_BASE_URL || "https://pro-api.coinmarketcap.com";

const POLL_MS = Math.max(
  60_000,
  parseInt(process.env.MARKET_FEED_POLL_MS || "300000", 10) || 300_000
);

const OHLCV_REFRESH_MS = Math.max(
  60_000,
  parseInt(process.env.OHLCV_CACHE_MS || "900000", 10) || 900_000
);

const KLINE_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.BINANCE_KLINE_CONCURRENCY || "6", 10) || 6
);

let lastOhlcvRefreshAt = 0;

function apiKey(): string {
  return (
    process.env.CMC_PRO_API_KEY?.trim() ||
    process.env.CMC_API_KEY?.trim() ||
    ""
  );
}

function universeSymbols(): string[] {
  // Shared feed covers Spot/Alpha (from env universe) ∪ bStocks so any agent type can consume quotes
  const base = getEligibleScanUniverse().filter((s) => !isStablecoin(s));
  return [...new Set([...base, ...getBstocksSymbols()])];
}

async function cmcFetch(path: string): Promise<Record<string, unknown> | null> {
  const key = apiKey();
  if (!key) return null;
  const url = `${CMC_PRO_BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        "X-CMC_PRO_API_KEY": key,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn("Market feed CMC error", { status: res.status, path });
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    logger.warn("Market feed CMC fetch failed", { path, error: String(err) });
    return null;
  }
}

async function fetchAllQuotes(symbols: string[]): Promise<Map<string, MarketData>> {
  const out = new Map<string, MarketData>();
  for (let i = 0; i < symbols.length; i += FULL_SCAN_BATCH_SIZE) {
    const batch = symbols.slice(i, i + FULL_SCAN_BATCH_SIZE);
    const raw = await cmcFetch(
      `/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(batch.join(","))}&convert=USD`
    );
    const parsed = parseCmcQuotesBatch(raw, batch);
    for (const [sym, md] of parsed) out.set(sym, md);
  }
  return out;
}

async function mapPool<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

async function refreshOhlcv(
  symbols: string[],
  prev: Record<string, PricePoint[]>
): Promise<Record<string, PricePoint[]>> {
  const next: Record<string, PricePoint[]> = { ...prev };
  const force =
    lastOhlcvRefreshAt === 0 ||
    Date.now() - lastOhlcvRefreshAt >= OHLCV_REFRESH_MS;

  const targets = symbols
    .map((symbol) => {
      const address = knownBscAddress(symbol);
      if (!address) return null;
      if (!force && next[symbol]?.length) return null;
      return { symbol, address };
    })
    .filter((x): x is { symbol: string; address: string } => x !== null);

  if (targets.length === 0) return next;

  await mapPool(
    targets,
    async ({ symbol, address }) => {
      const points = await fetchTokenKlines(address, {
        limit: 48,
        interval: "15min",
      });
      if (points.length >= 14) {
        next[symbol] = points;
      }
      return points;
    },
    KLINE_CONCURRENCY
  );

  lastOhlcvRefreshAt = Date.now();
  return next;
}

export async function pollOnce(): Promise<MarketFeedSnapshot> {
  const started = Date.now();
  await refreshBinanceAlphaTokens();
  const symbols = universeSymbols();
  const prev = getSnapshot();
  let lastError: string | undefined;

  let quotes = new Map<string, MarketData>();
  let usedStaleQuotes = false;
  try {
    quotes = await fetchAllQuotes(symbols);
  } catch (err) {
    lastError = `quotes: ${String(err)}`;
  }

  // Fill gaps from previous snapshot — do NOT refresh updatedAt when fully stale
  if (quotes.size === 0 && Object.keys(prev.quotes).length > 0) {
    usedStaleQuotes = true;
    for (const [k, v] of Object.entries(prev.quotes)) {
      quotes.set(k, v);
    }
  }

  let fearGreed: number | null = prev.fearGreed;
  try {
    const raw = await cmcFetch("/v3/fear-and-greed/latest");
    const parsed = raw ? parseFearGreedIndex(raw) : null;
    if (parsed !== null) fearGreed = parsed;
  } catch (err) {
    lastError = lastError || `fearGreed: ${String(err)}`;
  }

  let trending = prev.trending;
  try {
    const parsed = await fetchBinanceWeb3Trending({ limit: 50 });
    if (parsed.length) trending = parsed;
  } catch (err) {
    lastError = lastError || `trending: ${String(err)}`;
  }

  // Prefer symbols with quotes + known BSC addresses for OHLCV.
  // Always include BSC-mapped symbols missing CMC quotes (e.g. bStocks).
  const missingBsc = symbols.filter(
    (s) => knownBscAddress(s) && !quotes.has(s)
  );
  const ohlcvSymbols = [
    ...new Set([
      ...[...quotes.keys()].filter((s) => knownBscAddress(s)),
      ...trending.map((t) => t.symbol).filter((s) => knownBscAddress(s)),
      ...missingBsc,
      ...(quotes.size === 0
        ? symbols.filter((s) => knownBscAddress(s))
        : []),
    ]),
  ];

  let ohlcv = prev.ohlcv;
  try {
    ohlcv = await refreshOhlcv(ohlcvSymbols, prev.ohlcv);
  } catch (err) {
    lastError = lastError || `ohlcv: ${String(err)}`;
  }

  // Patch missing CMC quotes from Binance live when we have OHLCV targets
  for (const symbol of ohlcvSymbols) {
    if (quotes.has(symbol)) continue;
    const address = knownBscAddress(symbol);
    if (!address) continue;
    try {
      const live = await fetchTokenDynamic(address);
      if (live?.price) {
        quotes.set(symbol, {
          symbol,
          price: live.price,
          timestamp: Date.now(),
          change24h: live.change24hPct,
          volume24h: live.volume24h,
        });
      }
    } catch {
      /* skip */
    }
  }

  const quoteRecord: Record<string, MarketData> = {};
  for (const [k, v] of quotes) quoteRecord[k] = v;

  let tokenIcons = prev.tokenIcons ?? {};
  try {
    const iconSymbols = [
      ...new Set([
        ...symbols,
        ...Object.keys(quoteRecord),
        ...trending.map((t) => t.symbol),
      ]),
    ];
    const freshIcons = await buildTokenIconMap(iconSymbols, {
      alphaIcon: getBinanceAlphaIcon,
    });
    tokenIcons = { ...tokenIcons, ...freshIcons };
  } catch (err) {
    lastError = lastError || `icons: ${String(err)}`;
  }

  const snap: MarketFeedSnapshot = {
    // Keep previous timestamp when serving cached quotes so agents treat feed as stale
    updatedAt: usedStaleQuotes && prev.updatedAt > 0 ? prev.updatedAt : Date.now(),
    fearGreed,
    trending,
    quotes: quoteRecord,
    ohlcv,
    tokenIcons,
    meta: {
      quoteCount: Object.keys(quoteRecord).length,
      ohlcvCount: Object.keys(ohlcv).length,
      trendingCount: trending.length,
      pollMs: Date.now() - started,
      lastError,
      quotesStale: usedStaleQuotes,
    },
  };

  setSnapshot(snap);
  logger.info("Market feed snapshot updated", {
    quotes: snap.meta.quoteCount,
    ohlcv: snap.meta.ohlcvCount,
    trending: snap.meta.trendingCount,
    icons: Object.keys(snap.tokenIcons).length,
    fearGreed: snap.fearGreed,
    durationMs: snap.meta.pollMs,
    lastError,
  });
  return snap;
}

export function startPollLoop(): void {
  const run = () => {
    pollOnce().catch((err) =>
      logger.warn("Market feed poll failed", { error: String(err) })
    );
  };
  run();
  setInterval(run, POLL_MS);
  logger.info("Market feed poll loop started", { pollMs: POLL_MS });
}

export { POLL_MS };
