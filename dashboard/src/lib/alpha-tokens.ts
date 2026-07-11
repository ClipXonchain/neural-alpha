/**
 * Binance Alpha on BSC — synced from Binance public API (~300+ tokens).
 * Static fallback used when API is unavailable.
 */
export const BINANCE_ALPHA_STATIC = [
  "0G", "AB", "APR", "ASTER", "B", "BANANAS31", "BARD", "BAS", "BEAT", "BILL",
  "BSB", "CHEEMS", "COAI", "CYS", "EDGE", "FF", "GENIUS", "GUA", "GWEI", "H",
  "HOME", "HUMA", "IP", "IRYS", "KITE", "KOGE", "LAB", "M", "MYX", "NEX",
  "NIGHT", "NXPC", "OPEN", "PEAQ", "PIEVERSE", "Q", "RAVE", "RIVER", "SAHARA",
  "SIREN", "SKYAI", "SLX", "SOON", "TAC", "TAG", "TOSHI", "TRIA", "U", "UAI",
  "UB", "VELO", "XPL", "ZAMA",
] as const;

let liveAlphaSet: Set<string> | null = null;
let liveAlphaIcons: Record<string, string> | null = null;
let liveAlphaFetchedAt = 0;
const LIVE_CACHE_MS = 6 * 60 * 60 * 1000;

/** Binance Spot majors (static). */
export const BINANCE_SPOT_TOKENS = new Set<string>([
  "BNB", "ETH", "XRP", "TRX", "DOGE", "ZEC", "ADA", "LINK", "BCH",
  "TON", "LTC", "AVAX", "SHIB", "DOT", "UNI", "ETC", "AAVE", "ATOM", "FIL",
  "INJ", "FET", "CAKE", "LDO", "PENDLE", "AXS", "COMP", "APE", "SNX", "DEXE",
  "1INCH", "SUSHI", "STG", "ZRO", "SFP", "BAT", "YFI", "ACH", "AXL", "ELF",
  "KAVA", "DUSK", "TWT", "FLOKI", "BONK", "PENGU", "LUNC", "BTT", "HTX",
  "XCN", "RAY", "ZIL", "ROSE", "BRETT", "BABYDOGE", "FORM", "PLUME", "XPR",
  "ZETA", "AIOZ", "ZIG", "BEAM", "GOMINING",
]);

function fallbackAlphaSet(): Set<string> {
  return new Set(BINANCE_ALPHA_STATIC.map((s) => s.toUpperCase()));
}

/** Load live Binance Alpha BSC symbols (client-side, cached 6h). */
export async function loadLiveAlphaTokens(): Promise<Set<string>> {
  if (liveAlphaSet && Date.now() - liveAlphaFetchedAt < LIVE_CACHE_MS) {
    return liveAlphaSet;
  }
  try {
    const res = await fetch("/api/alpha-tokens");
    if (!res.ok) return liveAlphaSet ?? fallbackAlphaSet();
    const body = (await res.json()) as { symbols?: string[]; icons?: Record<string, string> };
    if (!Array.isArray(body.symbols) || body.symbols.length === 0) {
      return liveAlphaSet ?? fallbackAlphaSet();
    }
    liveAlphaSet = new Set(body.symbols.map((s) => s.toUpperCase()));
    if (body.icons && typeof body.icons === "object") {
      liveAlphaIcons = body.icons;
    }
    liveAlphaFetchedAt = Date.now();
    return liveAlphaSet;
  } catch {
    return liveAlphaSet ?? fallbackAlphaSet();
  }
}

/** Cached Alpha token logos from Binance API (populated by loadLiveAlphaTokens). */
export function getLiveAlphaIcons(): Record<string, string> {
  return liveAlphaIcons ?? {};
}

export function isAlphaToken(symbol: string, alphaSet?: Set<string>): boolean {
  const upper = symbol.toUpperCase();
  const set = alphaSet ?? liveAlphaSet ?? fallbackAlphaSet();
  return set.has(upper);
}

export function isSpotToken(symbol: string): boolean {
  return BINANCE_SPOT_TOKENS.has(symbol.toUpperCase());
}

export function isSafeListedToken(symbol: string, alphaSet?: Set<string>): boolean {
  const upper = symbol.toUpperCase();
  return isSpotToken(upper) || isAlphaToken(upper, alphaSet);
}

/** Approximate safe-list size for labels (spot + live alpha). */
export const SAFE_LIST_SIZE =
  BINANCE_SPOT_TOKENS.size + BINANCE_ALPHA_STATIC.length;
