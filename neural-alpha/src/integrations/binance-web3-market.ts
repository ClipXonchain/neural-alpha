import type { PricePoint } from "../utils/types.js";
import { loadPriceHistory, hasRealHistory, getHistoryAgeMs } from "../data/market.js";
import { logger } from "../utils/logger.js";
import { BSC_CHAIN_ID } from "./binance-web3-wallet.js";
import { getKnownBscTokenAddress, knownBscAddress, BSC_TOKEN_ADDRESSES } from "./bsc-token-addresses.js";

const META_URL =
  "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/dex/market/token/meta/info/ai";
const DYNAMIC_URL =
  "https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai";
const KLINE_URL = "https://dquery.sintral.io/u-kline/v1/k-line/candles";

const DEFAULT_HEADERS = {
  clienttype: "web",
  clientversion: "1.2.0",
  "User-Agent": "binance-web3/2.0 (NeuralAlpha)",
};

/** Token logos are served from bnbstatic CDN (web3.binance.com image paths 404/WAF in browsers). */
const ICON_CDN = "https://bin.bnbstatic.com";

export interface BinanceLiveQuote {
  price: number;
  change24hPct: number;
  volume24h: number;
  updatedAt: number;
}

export interface BinanceTokenMeta {
  symbol: string;
  name: string;
  icon?: string;
  contractAddress: string;
}

const iconCache = new Map<string, string>();
const metaCache = new Map<string, BinanceTokenMeta>();
const klineCache = new Map<string, { points: PricePoint[]; fetchedAt: number }>();

export const OHLCV_CACHE_MS = parseInt(process.env.OHLCV_CACHE_MS || "900000", 10) || 900_000;
const KLINE_TIMEOUT_MS = parseInt(process.env.BINANCE_KLINE_TIMEOUT_MS || "12000", 10) || 12_000;
const MARKET_CONCURRENCY = parseInt(process.env.BINANCE_MARKET_CONCURRENCY || "8", 10) || 8;
const KLINE_CONCURRENCY = parseInt(process.env.BINANCE_KLINE_CONCURRENCY || "6", 10) || 6;

/** Reject Binance on-chain quotes that disagree wildly with a reference (e.g. CMC). */
export function isPlausibleLivePrice(
  referencePrice: number | undefined,
  livePrice: number
): boolean {
  if (!Number.isFinite(livePrice) || livePrice <= 0) return false;
  if (referencePrice === undefined || referencePrice <= 0) return true;
  const ratio = livePrice / referencePrice;
  return ratio >= 0.02 && ratio <= 50;
}

export function normalizeBinanceIcon(icon?: string): string | undefined {
  if (!icon) return undefined;
  const trimmed = icon.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    if (trimmed.includes("web3.binance.com/images/")) {
      return trimmed.replace(/^https?:\/\/web3\.binance\.com/, ICON_CDN);
    }
    return trimmed;
  }

  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${ICON_CDN}${path}`;
}

function parseNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: DEFAULT_HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTokenMeta(
  contractAddress: string,
  chainId = BSC_CHAIN_ID
): Promise<BinanceTokenMeta | null> {
  const key = contractAddress.toLowerCase();
  const cached = metaCache.get(key);
  if (cached) return cached;

  const url = `${META_URL}?chainId=${chainId}&contractAddress=${encodeURIComponent(contractAddress)}`;
  const json = await fetchJson<{ code?: string; data?: Record<string, unknown> }>(url);
  if (!json?.data || json.code !== "000000") return null;

  const d = json.data;
  const symbol = String(d.symbol ?? "").toUpperCase();
  if (!symbol) return null;

  const meta: BinanceTokenMeta = {
    symbol,
    name: String(d.name ?? symbol),
    icon: normalizeBinanceIcon(d.icon ? String(d.icon) : undefined),
    contractAddress: String(d.contractAddress ?? contractAddress),
  };
  metaCache.set(key, meta);
  if (meta.icon) iconCache.set(symbol, meta.icon);
  return meta;
}

export async function fetchTokenDynamic(
  contractAddress: string,
  chainId = BSC_CHAIN_ID
): Promise<BinanceLiveQuote | null> {
  const url = `${DYNAMIC_URL}?chainId=${chainId}&contractAddress=${encodeURIComponent(contractAddress)}`;
  const json = await fetchJson<{ code?: string; data?: Record<string, unknown> }>(url);
  if (!json?.data || json.code !== "000000") return null;

  const d = json.data;
  const price = parseNum(d.price ?? d.aggPrice);
  if (price <= 0) return null;

  return {
    price,
    change24hPct: parseNum(
      d.percentChange24h ?? d.priceChangePct24h ?? d.percentChange24h
    ),
    volume24h: parseNum(d.volume24h),
    updatedAt: Date.now(),
  };
}

export async function fetchTokenKlines(
  contractAddress: string,
  opts: { interval?: string; limit?: number; timeoutMs?: number } = {}
): Promise<PricePoint[]> {
  const interval = opts.interval ?? "15min";
  const limit = opts.limit ?? 48;
  const cacheKey = `${contractAddress.toLowerCase()}:${interval}:${limit}`;
  const cached = klineCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < OHLCV_CACHE_MS) {
    return cached.points;
  }

  const params = new URLSearchParams({
    address: contractAddress,
    interval,
    limit: String(limit),
    platform: "bsc",
  });
  const json = await fetchJson<{ data?: unknown[] }>(
    `${KLINE_URL}?${params}`,
    opts.timeoutMs ?? KLINE_TIMEOUT_MS
  );
  if (!json?.data || !Array.isArray(json.data)) return cached?.points ?? [];

  const points: PricePoint[] = [];
  for (const row of json.data) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const open = parseNum(row[0]);
    const high = parseNum(row[1]);
    const low = parseNum(row[2]);
    const close = parseNum(row[3]);
    const volume = parseNum(row[4]);
    const timestamp = parseNum(row[5]);
    if (close <= 0 || timestamp <= 0) continue;
    points.push({ timestamp, open, high, low, close, volume });
  }

  points.sort((a, b) => a.timestamp - b.timestamp);
  if (points.length > 0) {
    klineCache.set(cacheKey, { points, fetchedAt: Date.now() });
  }
  return points;
}

export function getCachedIcon(symbol: string): string | undefined {
  return iconCache.get(symbol.toUpperCase());
}

export function cacheIcon(symbol: string, icon?: string) {
  const normalized = normalizeBinanceIcon(icon);
  if (normalized) iconCache.set(symbol.toUpperCase(), normalized);
}

/** Resolve icon from wallet position row. */
export function iconFromWalletRow(icon?: string): string | undefined {
  return normalizeBinanceIcon(icon);
}

async function mapPool<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface BinanceMarketEnrichment {
  liveQuotes: Map<string, BinanceLiveQuote>;
  icons: Map<string, string>;
  ohlcvLoaded: string[];
}

/**
 * Enrich symbols with Binance Web3 live prices, logos, and OHLCV candles.
 */
export async function enrichSymbolsFromBinance(
  symbols: string[],
  opts: {
    fetchLive?: boolean;
    fetchIcons?: boolean;
    fetchOhlcv?: boolean;
    ohlcvSymbols?: string[];
  } = {}
): Promise<BinanceMarketEnrichment> {
  const liveQuotes = new Map<string, BinanceLiveQuote>();
  const icons = new Map<string, string>();
  const ohlcvLoaded: string[] = [];

  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const withAddress = unique
    .map((symbol) => ({ symbol, address: resolveAddress(symbol) }))
    .filter((x): x is { symbol: string; address: string } => !!x.address);

  if (opts.fetchIcons !== false) {
    await mapPool(
      withAddress.filter(({ symbol }) => !getCachedIcon(symbol)),
      async ({ symbol, address }) => {
        const meta = await fetchTokenMeta(address);
        if (meta?.icon) icons.set(symbol, meta.icon);
        return null;
      },
      MARKET_CONCURRENCY
    );
    for (const symbol of unique) {
      const cached = getCachedIcon(symbol);
      if (cached) icons.set(symbol, cached);
    }
  }

  if (opts.fetchLive !== false) {
    await mapPool(
      withAddress,
      async ({ symbol, address }) => {
        const quote = await fetchTokenDynamic(address);
        if (quote) liveQuotes.set(symbol, quote);
        return null;
      },
      MARKET_CONCURRENCY
    );
  }

  if (opts.fetchOhlcv) {
    const ohlcvSet = new Set(
      (opts.ohlcvSymbols ?? unique).map((s) => s.toUpperCase())
    );
    const ohlcvTargets = withAddress.filter(({ symbol }) => {
      if (!ohlcvSet.has(symbol)) return false;
      const age = getHistoryAgeMs(symbol);
      if (hasRealHistory(symbol) && age !== null && age < OHLCV_CACHE_MS) {
        return false;
      }
      return true;
    });

    await mapPool(
      ohlcvTargets,
      async ({ symbol, address }) => {
        const points = await fetchTokenKlines(address, { limit: 48, interval: "15min" });
        if (points.length >= 14) {
          loadPriceHistory(symbol, points, { fromKlines: true });
          ohlcvLoaded.push(symbol);
        }
        return points;
      },
      KLINE_CONCURRENCY
    );
  }

  return { liveQuotes, icons, ohlcvLoaded };
}

/** All symbols with a static BEP-20 contract in our map. */
export function listKnownBscTokenSymbols(): string[] {
  return Object.keys(BSC_TOKEN_ADDRESSES);
}

function resolveAddress(symbol: string): string | undefined {
  return knownBscAddress(symbol) ?? getKnownBscTokenAddress(symbol);
}

export function getKlinePoints(symbol: string): PricePoint[] {
  const address = resolveAddress(symbol);
  if (!address) return [];
  const cacheKey = `${address.toLowerCase()}:15min:48`;
  return klineCache.get(cacheKey)?.points ?? [];
}
