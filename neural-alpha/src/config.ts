import type { AgentConfig } from "./utils/types.js";
import { getSessionProfile, resolveStrategyName } from "./strategy/presets.js";
import { getSessionClock } from "./strategy/session.js";
import { isUserBlacklisted } from "./risk/token-blacklist.js";
import { getEligibleBstockSymbols, isEligibleBstock } from "./integrations/bstock.js";
import { parseX402Settings } from "./integrations/campaign-x402-schedule.js";

/** Fallback watchlist used before the type=3 bootstrap completes. */
const BSTOCK_FALLBACK = [
  "NVDAB", "AAPLB", "TSLAB", "MSFTB", "GOOGLB", "AMZNB", "METAB", "PLTRB",
  "SPYB", "QQQB", "NFLXB", "AMDB", "INTCB", "AVGOB", "ORCLB", "COINB", "MSTRB",
];

/**
 * Campaign-eligible bStocks (suffix B). Populated from the type=3 API + weekly
 * list at bootstrap; this array is the fallback until then.
 */
export let ELIGIBLE_TOKENS: string[] = [...BSTOCK_FALLBACK];

export function setEligibleTokens(symbols: string[]) {
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))];
  if (unique.length > 0) ELIGIBLE_TOKENS = unique;
}

/** Leveraged / inverse ETFs — excluded from new buys unless ALLOW_LEVERAGED_BSTOCKS=true. */
export const EXCLUDED_TOKENS = new Set<string>([
  ...(process.env.EXCLUDED_TOKENS?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) ?? []),
]);

/** Skip tokens priced below this USD threshold. */
export const MIN_TRADABLE_PRICE_USD = parseFloat(
  process.env.MIN_TRADABLE_PRICE_USD || "0.01"
);

export const STABLECOINS = new Set([
  "USDT", "USDC", "DAI", "USD1", "USDe", "USDD", "TUSD", "FDUSD", "USDf",
  "FRAX", "FRXUSD", "USDF", "DUSD", "lisUSD", "EURI", "XUSD", "STABLE", "U", "BNB",
]);

/** High-conviction bStocks — always on watchlist */
export const MOMENTUM_CORE = [
  "NVDAB", "AAPLB", "TSLAB", "MSFTB", "GOOGLB", "AMZNB", "METAB", "PLTRB",
];

/** Rotated in when showing movement */
export const MOMENTUM_VOLATILE = [
  "COINB", "MSTRB", "HOODB", "NFLXB", "AMDB", "CRCLB", "IRENB", "GMEB",
];

/** Low-beta index bStocks */
export const ANCHOR_TOKENS = ["SPYB", "QQQB"];

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
  return [...MOMENTUM_CORE, ...ANCHOR_TOKENS].filter((s) =>
    isTradableToken(s)
  );
}

export function isExcludedToken(symbol: string): boolean {
  return EXCLUDED_TOKENS.has(symbol.toUpperCase());
}

export function isEligibleToken(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  if (isEligibleBstock(upper)) return true;
  return ELIGIBLE_TOKENS.includes(upper);
}

/** Competition-eligible, not stable, not blocklisted, and above min price when known. */
export function isTradableToken(symbol: string, price?: number | null): boolean {
  const upper = symbol.toUpperCase();
  if (!isEligibleToken(upper)) return false;
  if (isStablecoin(upper)) return false;
  if (isExcludedToken(upper)) return false;
  if (isUserBlacklisted(upper)) return false;
  if (price != null && price > 0 && price < MIN_TRADABLE_PRICE_USD) return false;
  return true;
}

export const COMPETITION_CONTRACT = "";

export const BSC_CHAIN = "bsc";
export const BSC_CHAIN_ID = process.env.BINANCE_CHAIN_ID?.trim() || "56";

/** BSC mainnet USDT (BEP-20) — default payment token for campaign swaps */
export const BSC_USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";

/** Minimum BNB (USD value) kept for gas — BNB is never used as swap currency */
export const MIN_GAS_RESERVE_USD = parseFloat(process.env.MIN_GAS_RESERVE_USD || "1.5");

/** Ignore wallet holdings below this USD value (dust + balance API noise). */
export const MIN_POSITION_VALUE_USD = parseFloat(process.env.MIN_POSITION_VALUE_USD || "1");

/** Buys must be funded with a campaign payment token (BNB/USDT/USDC/U/USD1). */
export function parseSwapCurrencies(_raw?: string): string[] {
  const preferred = (process.env.PAYMENT_TOKEN || "USDT").toUpperCase();
  if (["BNB", "USDT", "USDC", "U", "USD1"].includes(preferred)) return [preferred];
  return ["USDT"];
}

export function isSwapCurrency(symbol: string, swapCurrencies: string[]): boolean {
  return swapCurrencies.includes(symbol.toUpperCase());
}

export function loadConfig(): AgentConfig {
  const mode = (process.env.AGENT_MODE as "live" | "paper") || "paper";
  const defaultInterval = mode === "paper" ? "30000" : "300000"; // 30s paper, 5min live

  const sessionPolicy = resolveStrategyName(
    process.env.SESSION_POLICY || process.env.STRATEGY
  );
  const clock = getSessionClock(sessionPolicy);
  const profile = getSessionProfile(clock.active);
  const r = profile.risk;
  const num = (env: string | undefined, fallback: number) =>
    env !== undefined && env !== "" ? parseFloat(env) : fallback;

  const disableDrawdownLimit = process.env.DISABLE_DRAWDOWN_LIMIT === "true";
  const maxDrawdownPct = disableDrawdownLimit
    ? 100
    : num(process.env.MAX_DRAWDOWN_PCT, r.maxDrawdownPct);

  return {
    mode,
    sessionPolicy,
    positionSizeMultiplier: profile.positionSizeMultiplier,
    tradeIntervalMs: parseInt(process.env.TRADE_INTERVAL_MS || defaultInterval, 10),
    maxPositionSizeUsd: num(process.env.MAX_POSITION_SIZE_USD, 250),
    maxDrawdownPct,
    drawdownLimitEnabled: !disableDrawdownLimit && maxDrawdownPct < 100,
    signalRefreshMs: parseInt(process.env.SIGNAL_REFRESH_MS || "10000", 10),
    protectiveExitCheckMs: parseInt(process.env.PROTECTIVE_EXIT_CHECK_MS || "60000", 10),
    slippageTolerance: num(process.env.SLIPPAGE_TOLERANCE, 1),
    minGasReserveUsd: num(process.env.MIN_GAS_RESERVE_USD, 1.5),
    baseCurrency: "USDT",
    swapCurrencies: parseSwapCurrencies(),
    maxPortfolioTokens: Math.round(num(process.env.MAX_PORTFOLIO_TOKENS, r.maxPortfolioTokens)),
    minTradeAmountUsd: num(process.env.MIN_TRADE_AMOUNT_USD, 5),
    rebalanceThresholdPct: 10,
    stopLossPct: num(process.env.STOP_LOSS_PCT, r.stopLossPct),
    takeProfitPct: num(process.env.TAKE_PROFIT_PCT, r.takeProfitPct),
    trailingActivatePct: num(process.env.TRAILING_ACTIVATE_PCT, r.trailingActivatePct),
    trailingGivebackPct: num(process.env.TRAILING_GIVEBACK_PCT, r.trailingGivebackPct),
    minBuyConfidence: num(process.env.MIN_BUY_CONFIDENCE, r.minBuyConfidence),
    autoExitEnabled: process.env.AUTO_EXIT_ENABLED !== "false",
    failedSwapCooldownMs: parseInt(process.env.FAILED_SWAP_COOLDOWN_MS || "1800000", 10),
    minBuyIntervalMs: parseInt(process.env.MIN_BUY_INTERVAL_MS || "600000", 10),
    ...parseX402Settings(),
  };
}

export function isStablecoin(symbol: string): boolean {
  return STABLECOINS.has(symbol.toUpperCase());
}
