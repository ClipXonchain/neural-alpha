import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How long a successful Binance BNBUSDT quote is reused. */
export const BNB_PRICE_REFRESH_MS = 4 * 60 * 60 * 1000;
/** Retry while Binance is unreachable. A good quote still waits the full 4 hours. */
export const BNB_PRICE_RETRY_MS = 60 * 1000;

/** Official Binance spot last price, then the official public market-data mirror. */
export const BINANCE_BNBUSDT_URLS = [
  "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT",
  "https://data-api.binance.vision/api/v3/ticker/price?symbol=BNBUSDT",
];

const MIN_BNB_USD = 10;
const MAX_BNB_USD = 100_000;

export function parseBinanceBnbTicker(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("binance ticker was not an object");
  }
  if (payload.symbol !== "BNBUSDT") {
    throw new Error("binance ticker symbol was not BNBUSDT");
  }
  const price = Number(payload.price);
  if (!Number.isFinite(price) || price < MIN_BNB_USD || price > MAX_BNB_USD) {
    throw new Error("binance BNBUSDT price is outside the accepted range");
  }
  return price;
}

function readCache(cachePath, nowMs) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    const priceUsd = parseBinanceBnbTicker({ symbol: "BNBUSDT", price: parsed?.priceUsd });
    const fetchedAtMs = Date.parse(parsed?.fetchedAt);
    if (!Number.isFinite(fetchedAtMs)) return null;
    return { priceUsd, fetchedAtMs, ageMs: nowMs - fetchedAtMs };
  } catch {
    return null;
  }
}

function writeCache(cachePath, record) {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(tmp, cachePath);
}

/**
 * Live BNB/USD mark for the software fee. Checkout stores the BNB amount it
 * calculated, so a later refresh does not change an open quote.
 */
export function createBnbPriceFeed({
  fallbackUsd,
  cachePath,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = BNB_PRICE_REFRESH_MS,
  retryMs = BNB_PRICE_RETRY_MS,
  urls = BINANCE_BNBUSDT_URLS,
} = {}) {
  const fallback = Number(fallbackUsd);
  if (!Number.isFinite(fallback) || fallback <= 0) {
    throw new Error("fallback BNB price must be a positive number");
  }
  let priceUsd = fallback;
  let source = "fallback";
  let updatedAt = null;
  let timer = null;
  let stopped = false;

  function snapshot() {
    return { priceUsd, source, updatedAt };
  }

  function remember(nextPrice, stampMs) {
    priceUsd = nextPrice;
    source = "binance";
    updatedAt = new Date(stampMs).toISOString();
    if (cachePath) {
      try {
        writeCache(cachePath, { symbol: "BNBUSDT", priceUsd, fetchedAt: updatedAt });
      } catch {
        /* a missing cache must not block checkout */
      }
    }
  }

  async function refresh() {
    for (const url of urls) {
      try {
        const response = await fetchImpl(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response?.ok) continue;
        const payload = await response.json();
        remember(parseBinanceBnbTicker(payload), now());
        return snapshot();
      } catch {
        /* try the next official endpoint */
      }
    }
    return snapshot();
  }

  function schedule(delayMs) {
    if (stopped) return;
    const delay = Math.max(0, Number(delayMs) || 0);
    timer = setTimeout(() => {
      refresh()
        .then((snap) => schedule(snap.source === "binance" ? ttlMs : retryMs))
        .catch(() => schedule(retryMs));
    }, delay);
    timer.unref?.();
  }

  async function start() {
    const nowMs = now();
    const cached = cachePath ? readCache(cachePath, nowMs) : null;
    if (cached) {
      priceUsd = cached.priceUsd;
      source = "binance";
      updatedAt = new Date(cached.fetchedAtMs).toISOString();
      if (cached.ageMs >= 0 && cached.ageMs < ttlMs) {
        schedule(ttlMs - cached.ageMs);
        return snapshot();
      }
    }
    const snap = await refresh();
    schedule(snap.source === "binance" ? ttlMs : retryMs);
    return snap;
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    priceUsd: () => priceUsd,
    snapshot,
    refresh,
    start,
    stop,
  };
}
