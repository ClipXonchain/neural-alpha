import { logger } from "../utils/logger.js";
import { isTokenizedStockOrEtf } from "../utils/tokenized-stocks.js";

const ALPHA_LIST_URL =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";

/** Static fallback when Binance API is unreachable (subset from alpha.md). */
export const BINANCE_ALPHA_STATIC_FALLBACK: string[] = [
  "0G", "AB", "APR", "ASTER", "B", "BANANAS31", "BARD", "BAS", "BEAT", "BILL",
  "BSB", "CHEEMS", "COAI", "CYS", "EDGE", "FF", "GENIUS", "GUA", "GWEI", "H",
  "HOME", "HUMA", "IP", "IRYS", "KITE", "KOGE", "LAB", "M", "MYX", "NEX",
  "NIGHT", "NXPC", "OPEN", "PEAQ", "PIEVERSE", "Q", "RAVE", "RIVER", "SAHARA",
  "SIREN", "SKYAI", "SLX", "SOON", "TAC", "TAG", "TOSHI", "TRIA", "U", "UAI",
  "UB", "VELO", "XPL", "ZAMA",
];

const CACHE_TTL_MS = Math.max(
  3_600_000,
  parseInt(process.env.BINANCE_ALPHA_CACHE_MS || "21600000", 10) || 21_600_000
); // default 6h

export interface BinanceAlphaToken {
  symbol: string;
  contractAddress: string;
  name?: string;
  alphaId?: string;
  offline?: boolean;
  iconUrl?: string;
}

let cachedTokens: BinanceAlphaToken[] = [];
let cachedAt = 0;
let refreshInFlight: Promise<BinanceAlphaToken[]> | null = null;

const symbolSet = new Set<string>();
const addressBySymbol = new Map<string, string>();
const iconBySymbol = new Map<string, string>();

function normalizeAddress(addr: string): string | undefined {
  const trimmed = addr.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function seedStaticFallback() {
  symbolSet.clear();
  addressBySymbol.clear();
  iconBySymbol.clear();
  for (const sym of BINANCE_ALPHA_STATIC_FALLBACK) {
    const upper = sym.toUpperCase();
    symbolSet.add(upper);
  }
}

seedStaticFallback();

function isActiveBscAlpha(row: Record<string, unknown>): boolean {
  if (String(row.chainId) !== "56") return false;
  if (row.offline === true) return false;
  if (row.fullyDelisted === true) return false;
  const addr = normalizeAddress(String(row.contractAddress ?? ""));
  if (!addr) return false;
  const symbol = String(row.symbol ?? "").trim();
  if (!symbol) return false;
  return true;
}

function applyCache(tokens: BinanceAlphaToken[]) {
  cachedTokens = tokens;
  cachedAt = Date.now();
  symbolSet.clear();
  addressBySymbol.clear();
  iconBySymbol.clear();
  for (const t of tokens) {
    const upper = t.symbol.toUpperCase();
    symbolSet.add(upper);
    addressBySymbol.set(upper, t.contractAddress);
    if (t.iconUrl) iconBySymbol.set(upper, t.iconUrl);
  }
}

/** Fetch active Binance Alpha tokens on BSC from the public API. */
export async function fetchBinanceAlphaBscTokens(): Promise<BinanceAlphaToken[]> {
  const res = await fetch(ALPHA_LIST_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Binance Alpha list HTTP ${res.status}`);
  }

  const body = (await res.json()) as {
    success?: boolean;
    data?: Record<string, unknown>[];
  };
  const rows = Array.isArray(body.data) ? body.data : [];

  const out: BinanceAlphaToken[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!isActiveBscAlpha(row)) continue;
    const symbol = String(row.symbol).trim();
    const upper = symbol.toUpperCase();
    const name = row.name ? String(row.name) : undefined;
    // Never allow Ondo tokenized stocks/ETFs into the Alpha universe
    if (isTokenizedStockOrEtf(upper, name)) continue;
    const contractAddress = normalizeAddress(String(row.contractAddress))!;
    // Prefer first listing per symbol (API may return duplicates)
    if (seen.has(upper)) continue;
    seen.add(upper);
    const iconUrl = row.iconUrl ? String(row.iconUrl).trim() : undefined;
    out.push({
      symbol: upper,
      contractAddress,
      name,
      alphaId: row.alphaId ? String(row.alphaId) : undefined,
      offline: false,
      ...(iconUrl ? { iconUrl } : {}),
    });
  }

  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

/** Refresh in-memory Alpha cache (no-op if fresh unless force). */
export async function refreshBinanceAlphaTokens(
  opts: { force?: boolean } = {}
): Promise<BinanceAlphaToken[]> {
  if (
    !opts.force &&
    cachedTokens.length > 0 &&
    Date.now() - cachedAt < CACHE_TTL_MS
  ) {
    return cachedTokens;
  }

  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const tokens = await fetchBinanceAlphaBscTokens();
      if (tokens.length > 0) {
        applyCache(tokens);
        logger.info("Binance Alpha BSC list synced", {
          count: tokens.length,
          cacheTtlHours: Math.round(CACHE_TTL_MS / 3_600_000),
        });
        return tokens;
      }
      logger.warn("Binance Alpha API returned empty — keeping prior cache");
      return cachedTokens;
    } catch (err) {
      logger.warn("Binance Alpha sync failed — using static/cache fallback", {
        error: String(err),
        cached: cachedTokens.length,
        static: BINANCE_ALPHA_STATIC_FALLBACK.length,
      });
      if (cachedTokens.length === 0) seedStaticFallback();
      return cachedTokens;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function ensureBinanceAlphaTokensLoaded(): Promise<void> {
  await refreshBinanceAlphaTokens();
}

export function getBinanceAlphaSymbols(): string[] {
  return [...symbolSet];
}

export function isBinanceAlphaBscToken(symbol: string): boolean {
  return symbolSet.has(symbol.toUpperCase());
}

export function getBinanceAlphaContract(symbol: string): string | undefined {
  return addressBySymbol.get(symbol.toUpperCase());
}

export function getBinanceAlphaIcon(symbol: string): string | undefined {
  return iconBySymbol.get(symbol.toUpperCase());
}

/** All cached Alpha token logos (symbol → iconUrl). */
export function getBinanceAlphaIconMap(): Record<string, string> {
  return Object.fromEntries(iconBySymbol);
}

export function getBinanceAlphaTokenCount(): number {
  return symbolSet.size;
}

export function getBinanceAlphaSnapshot(): {
  count: number;
  updatedAt: number;
  source: "api" | "static";
} {
  return {
    count: symbolSet.size,
    updatedAt: cachedAt,
    source: cachedTokens.length > 0 ? "api" : "static",
  };
}
