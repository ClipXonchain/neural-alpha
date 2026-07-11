import type { AgentConfig } from "./utils/types.js";
import { getStrategyProfile, resolveStrategyName } from "./strategy/presets.js";
import { isUserBlacklisted } from "./risk/token-blacklist.js";
import { isBinanceAlphaBscToken, getBinanceAlphaSymbols } from "./integrations/binance-alpha-tokens.js";
import {
  getBstocksSymbols,
  isBstocksToken,
  BSTOCKS_CORE_WATCHLIST,
} from "./integrations/bstocks-tokens.js";
import { getMarketCap } from "./data/market-cap-cache.js";
import { isTokenizedStockOrEtf } from "./utils/tokenized-stocks.js";

export { isTokenizedStockOrEtf } from "./utils/tokenized-stocks.js";
export { isBstocksToken, getBstocksSymbols } from "./integrations/bstocks-tokens.js";

/**
 * Safe tradable universe = Binance Spot (BSC-routable) ∪ Binance Alpha.
 * New buys are blocked outside this list to reduce rug / unknown-token risk.
 */

/** Binance Spot majors with liquid BSC markets (wrapped / native listings). */
export const BINANCE_SPOT_TOKENS: string[] = [
  "BNB", "ETH", "XRP", "TRX", "DOGE", "ZEC", "ADA", "LINK", "BCH",
  "TON", "LTC", "AVAX", "SHIB", "DOT", "UNI", "ETC", "AAVE", "ATOM", "FIL",
  "INJ", "FET", "CAKE", "LDO", "PENDLE", "AXS", "COMP", "APE", "SNX", "DEXE",
  "1INCH", "SUSHI", "STG", "ZRO", "SFP", "BAT", "YFI", "ACH", "AXL", "ELF",
  "KAVA", "DUSK", "TWT", "FLOKI", "BONK", "PENGU", "LUNC", "BTT", "HTX",
  "XCN", "RAY", "ZIL", "ROSE", "BRETT", "BabyDoge", "FORM", "PLUME", "XPR",
  "ZETA", "AIOZ", "ZIG", "BEAM", "GOMINING",
];

/**
 * Binance Alpha (BSC) — static seed; live list synced from Binance API
 * (see integrations/binance-alpha-tokens.ts, ~300+ active BSC Alpha tokens).
 */
export const BINANCE_ALPHA_TOKENS: string[] = [
  "0G", "AB", "APR", "ASTER", "B", "BANANAS31", "BARD", "BAS", "BEAT", "BILL",
  "BSB", "CHEEMS", "COAI", "CYS", "EDGE", "FF", "GENIUS", "GUA", "GWEI", "H",
  "HOME", "HUMA", "IP", "IRYS", "KITE", "KOGE", "LAB", "M", "MYX", "NEX",
  "NIGHT", "NXPC", "OPEN", "PEAQ", "PIEVERSE", "Q", "RAVE", "RIVER", "SAHARA",
  "SIREN", "SKYAI", "SLX", "SOON", "TAC", "TAG", "TOSHI", "TRIA", "U", "UAI",
  "UB", "VELO", "XPL", "ZAMA",
];

/** Funding / settlement stables (never opened as directional positions). */
export const STABLECOINS = new Set([
  "USDT", "USDC", "DAI", "USD1", "USDE", "USDD", "TUSD", "FDUSD", "USDF",
  "FRAX", "FRXUSD", "DUSD", "LISUSD", "EURI", "XUSD", "STABLE",
]);

/** Full allowlist used by scans, signals, and new buys. */
export const ELIGIBLE_TOKENS: string[] = [
  ...new Set([
    ...BINANCE_SPOT_TOKENS.map((s) => s.toUpperCase()),
    ...BINANCE_ALPHA_TOKENS.map((s) => s.toUpperCase()),
    ...STABLECOINS,
  ]),
];

const BINANCE_SPOT_SET = new Set(BINANCE_SPOT_TOKENS.map((s) => s.toUpperCase()));
const BINANCE_ALPHA_SET = new Set(BINANCE_ALPHA_TOKENS.map((s) => s.toUpperCase()));
const ELIGIBLE_SET = new Set(ELIGIBLE_TOKENS);

/**
 * Mega-cap / top-rank tokens — excluded from scans, signals, trending, and new buys.
 * Focuses the agent on Binance Alpha and mid-cap Spot movers (not BTC/ETH/SOL-class names).
 * Override via EXCLUDED_TOKENS env (comma-separated) for additional symbols.
 */
export const HIGH_MCAP_EXCLUDED_TOKENS: readonly string[] = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX", "LINK", "AVAX",
  "DOT", "TON", "LTC", "BCH", "UNI", "ETC", "ATOM", "FIL", "SHIB", "HYPE",
  "ZEC", "NEAR", "APT", "SUI", "ARB", "OP", "POL", "MATIC", "ICP", "STX",
  "HBAR", "VET", "XLM", "ALGO", "EOS", "TAO", "RENDER", "QNT", "MKR",
];

const HIGH_MCAP_EXCLUDED_SET = new Set(HIGH_MCAP_EXCLUDED_TOKENS);

/** Skip tokens at or above this market cap (USD) when quote data is available. Default $10B. */
export const MAX_TRADABLE_MARKET_CAP_USD = parseFloat(
  process.env.MAX_TRADABLE_MARKET_CAP_USD || "10000000000"
);

/** Low-conviction / micro-cap — excluded from scans, signals, and new buys. */
export const EXCLUDED_TOKENS = new Set<string>([
  ...HIGH_MCAP_EXCLUDED_TOKENS,
  ...(process.env.EXCLUDED_TOKENS?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) ?? []),
  "NEX", "BTT", "AB", "BRETT", "U", "HTX", "RAY",
  "ZIL", "XCN", "BONK", "ROSE", "VELO", "LUNC", "FLOKI",
  "BABYDOGE", "GOMINING",
]);

/** Skip tokens priced below this USD threshold (meme/dust). */
export const MIN_TRADABLE_PRICE_USD = parseFloat(
  process.env.MIN_TRADABLE_PRICE_USD || "0.01"
);

/** High-momentum eligible tokens — always on watchlist */
export const MOMENTUM_CORE = [
  "FET", "PENDLE", "INJ", "APE", "CAKE", "1INCH", "SNX", "DEXE",
];

/** Rotated in when trending or showing movement */
export const MOMENTUM_VOLATILE = [
  "PENGU", "AXS", "COMP", "LDO", "SUSHI", "STG", "NXPC", "CHEEMS",
  "SIREN", "ASTER", "MYX", "RIVER",
];

/** Low-beta anchors for stability / hedge (mid-cap only — no mega-caps). */
export const ANCHOR_TOKENS = ["CAKE", "PENDLE", "INJ"];

export const MAX_WATCHLIST_SIZE = 15;

/** Full eligible-token scan every N cycles (~15 min at 5min interval) */
export const FULL_SCAN_INTERVAL = 3;

/** CMC quote batch size for full scans */
export const FULL_SCAN_BATCH_SIZE = 25;

/** Top movers promoted from full scan into active watchlist */
export const FULL_SCAN_PROMOTE_COUNT = 5;

/** @deprecated Use MOMENTUM_CORE / ANCHOR_TOKENS */
export const HIGH_CAP_TOKENS = ANCHOR_TOKENS;

/** @deprecated Use MOMENTUM_CORE / MOMENTUM_VOLATILE */
export const MID_CAP_TOKENS = MOMENTUM_CORE;

export function buildDefaultWatchlist(): string[] {
  if (getAgentUniverse() === "bstocks") {
    return BSTOCKS_CORE_WATCHLIST.filter((s) => isTradableToken(s));
  }
  return [...MOMENTUM_CORE, ...ANCHOR_TOKENS].filter((s) =>
    isTradableToken(s)
  );
}

export function isExcludedToken(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  if (EXCLUDED_TOKENS.has(upper)) return true;
  // Ondo *ON stocks blocked for crypto agents; allowed for bStocks universe
  if (getAgentUniverse() !== "bstocks" && isTokenizedStockOrEtf(upper)) {
    return true;
  }
  return false;
}

export function isHighMcapExcluded(symbol: string): boolean {
  return HIGH_MCAP_EXCLUDED_SET.has(symbol.toUpperCase());
}

export function isOverMaxMarketCap(marketCap?: number | null): boolean {
  if (marketCap == null || marketCap <= 0) return false;
  if (!Number.isFinite(MAX_TRADABLE_MARKET_CAP_USD) || MAX_TRADABLE_MARKET_CAP_USD <= 0) {
    return false;
  }
  return marketCap >= MAX_TRADABLE_MARKET_CAP_USD;
}

export function isBinanceSpotToken(symbol: string): boolean {
  return BINANCE_SPOT_SET.has(symbol.toUpperCase());
}

export function isBinanceAlphaToken(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  return BINANCE_ALPHA_SET.has(upper) || isBinanceAlphaBscToken(upper);
}

/** Deploy-time trading universe: spot | alpha | both | bstocks. */
export type AgentUniverse = "spot" | "alpha" | "both" | "bstocks";

export function resolveAgentUniverse(raw?: string | null): AgentUniverse {
  const v = (raw || process.env.AGENT_UNIVERSE || "").trim().toLowerCase();
  if (v === "spot" || v === "alpha" || v === "both" || v === "bstocks") return v;
  return "both";
}

export function getAgentUniverse(): AgentUniverse {
  return resolveAgentUniverse();
}

/** Tokens this agent may scan / buy, honoring AGENT_UNIVERSE. Stables always included. */
export function getEligibleScanUniverse(): string[] {
  const universe = getAgentUniverse();
  const spot = BINANCE_SPOT_TOKENS.map((s) => s.toUpperCase());
  const alpha = [
    ...BINANCE_ALPHA_TOKENS.map((s) => s.toUpperCase()),
    ...getBinanceAlphaSymbols(),
  ];
  const bstocks = getBstocksSymbols();

  if (universe === "spot") {
    return [...new Set([...spot, ...STABLECOINS])];
  }
  if (universe === "alpha") {
    return [...new Set([...alpha, ...STABLECOINS])];
  }
  if (universe === "bstocks") {
    return [...new Set([...bstocks, ...STABLECOINS])];
  }
  return [...new Set([...spot, ...alpha, ...STABLECOINS])];
}

/**
 * On this agent's allowlist (includes stables for funding).
 * Spot → Spot only; Alpha → Alpha only; bStocks → bStocks only; Default → Spot ∪ Alpha.
 */
export function isEligibleToken(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  if (isStablecoin(upper)) return true;

  const universe = getAgentUniverse();
  if (universe === "spot") return isBinanceSpotToken(upper);
  if (universe === "alpha") return isBinanceAlphaToken(upper);
  if (universe === "bstocks") return isBstocksToken(upper);
  return ELIGIBLE_SET.has(upper) || isBinanceAlphaBscToken(upper);
}

/**
 * May open a new buy: on allowlist, not stable, not excluded/blacklisted,
 * not mega-cap (static list or live mcap), not tokenized stocks/ETFs,
 * and above min price when known.
 */
export function isTradableToken(
  symbol: string,
  price?: number | null,
  marketCap?: number | null
): boolean {
  const upper = symbol.toUpperCase();
  if (!isEligibleToken(upper)) return false;
  if (isStablecoin(upper)) return false;
  if (isExcludedToken(upper)) return false;
  if (isUserBlacklisted(upper)) return false;
  if (price != null && price > 0 && price < MIN_TRADABLE_PRICE_USD) return false;

  const cap = marketCap ?? getMarketCap(upper);
  if (isOverMaxMarketCap(cap)) return false;

  return true;
}

export const BSC_CHAIN = "bsc";

/** BSC mainnet USDT (BEP-20) — base currency for swaps */
export const BSC_USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";

/** Minimum BNB (USD value) kept for gas — BNB is never used as swap currency */
export const MIN_GAS_RESERVE_USD = parseFloat(process.env.MIN_GAS_RESERVE_USD || "1.5");

/** Ignore wallet holdings below this USD value (dust + balance API noise). */
export const MIN_POSITION_VALUE_USD = parseFloat(process.env.MIN_POSITION_VALUE_USD || "1");

/** All buys and sells settle in USDT only — BNB is gas reserve only. */
export function parseSwapCurrencies(_raw?: string): string[] {
  return ["USDT"];
}

export function isSwapCurrency(symbol: string, swapCurrencies: string[]): boolean {
  return swapCurrencies.includes(symbol.toUpperCase());
}

export function loadConfig(): AgentConfig {
  if (process.env.AGENT_MODE && process.env.AGENT_MODE !== "live") {
    console.warn(
      `[config] AGENT_MODE=${process.env.AGENT_MODE} is ignored — only live trading is supported`
    );
  }
  const mode = "live" as const;
  const defaultInterval = "3600000";

  // Strategy preset supplies risk defaults; explicit env vars still override.
  const strategy = resolveStrategyName(process.env.STRATEGY);
  const profile = getStrategyProfile(strategy);
  const r = profile.risk;
  const num = (env: string | undefined, fallback: number) =>
    env !== undefined && env !== "" ? parseFloat(env) : fallback;

  const disableDrawdownLimit = process.env.DISABLE_DRAWDOWN_LIMIT === "true";
  const maxDrawdownPct = disableDrawdownLimit
    ? 100
    : num(process.env.MAX_DRAWDOWN_PCT, r.maxDrawdownPct);

  return {
    mode,
    strategy,
    agentUniverse: resolveAgentUniverse(process.env.AGENT_UNIVERSE),
    positionSizeMultiplier: profile.positionSizeMultiplier,
    tradeIntervalMs: parseInt(process.env.TRADE_INTERVAL_MS || defaultInterval, 10),
    maxPositionSizeUsd: num(process.env.MAX_POSITION_SIZE_USD, 100),
    maxDailyTrades: Math.round(
      process.env.MAX_DAILY_TRADES !== undefined && process.env.MAX_DAILY_TRADES !== ""
        ? parseFloat(process.env.MAX_DAILY_TRADES)
        : 10
    ),
    maxDrawdownPct,
    drawdownLimitEnabled: !disableDrawdownLimit && maxDrawdownPct < 100,
    signalRefreshMs: parseInt(process.env.SIGNAL_REFRESH_MS || "300000", 10),
    protectiveExitCheckMs: parseInt(process.env.PROTECTIVE_EXIT_CHECK_MS || "60000", 10),
    slippageTolerance: num(process.env.SLIPPAGE_TOLERANCE, 1),
    minGasReserveUsd: num(process.env.MIN_GAS_RESERVE_USD, MIN_GAS_RESERVE_USD),
    bscGasPriceGwei: num(process.env.BSC_GAS_PRICE_GWEI, 0),
    bscSwapGasLimit: Math.round(num(process.env.BSC_SWAP_GAS_LIMIT, 0)),
    baseCurrency: "USDT",
    swapCurrencies: parseSwapCurrencies(),
    maxPortfolioTokens: Math.round(num(process.env.MAX_PORTFOLIO_TOKENS, r.maxPortfolioTokens)),
    minTradeAmountUsd: num(process.env.MIN_TRADE_AMOUNT_USD, 5),
    rebalanceThresholdPct: 10,
    // Safety-first exit rules — keep per-trade losses small to limit drawdown.
    stopLossPct: num(process.env.STOP_LOSS_PCT, r.stopLossPct),
    takeProfitPct: num(process.env.TAKE_PROFIT_PCT, r.takeProfitPct),
    trailingActivatePct: num(process.env.TRAILING_ACTIVATE_PCT, r.trailingActivatePct),
    trailingGivebackPct: num(process.env.TRAILING_GIVEBACK_PCT, r.trailingGivebackPct),
    minBuyConfidence: num(process.env.MIN_BUY_CONFIDENCE, r.minBuyConfidence),
    startupCooldownMs: parseInt(process.env.STARTUP_TRADE_COOLDOWN_MS || "120000", 10),
    autoExitEnabled: process.env.AUTO_EXIT_ENABLED === "true",
    failedSwapCooldownMs: parseInt(process.env.FAILED_SWAP_COOLDOWN_MS || "1800000", 10),
    maxAutonomousTradesPerCycle: Math.round(
      num(process.env.MAX_AUTONOMOUS_TRADES_PER_CYCLE, 1)
    ),
    maxOnChainTxPerDay: Math.round(num(process.env.MAX_ONCHAIN_TX_PER_DAY, 10)),
  };
}

export function isStablecoin(symbol: string): boolean {
  return STABLECOINS.has(symbol.toUpperCase());
}
