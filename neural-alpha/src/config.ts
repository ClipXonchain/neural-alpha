import type { AgentConfig } from "./utils/types.js";
import { getStrategyProfile, resolveStrategyName } from "./strategy/presets.js";

export const ELIGIBLE_TOKENS: string[] = [
  "ETH", "USDT", "USDC", "XRP", "TRX", "DOGE", "ZEC", "ADA", "LINK", "BCH", "BNB",
  "DAI", "TON", "USD1", "USDe", "M", "LTC", "AVAX", "SHIB", "XAUt", "WLFI",
  "H", "DOT", "UNI", "ASTER", "DEXE", "USDD", "ETC", "AAVE", "ATOM", "U",
  "STABLE", "FIL", "INJ", "NIGHT", "FET", "TUSD", "BONK", "PENGU", "CAKE",
  "SIREN", "LUNC", "ZRO", "KITE", "FDUSD", "BEAT", "PIEVERSE", "BTT", "NFT",
  "EDGE", "FLOKI", "LDO", "B", "FF", "PENDLE", "NEX", "STG", "AXS", "TWT",
  "HOME", "RAY", "COMP", "GWEI", "XCN", "GENIUS", "XPL", "BAT", "SKYAI",
  "APE", "IP", "SFP", "TAG", "NXPC", "AB", "SAHARA", "1INCH", "CHEEMS",
  "BANANAS31", "RIVER", "MYX", "RAVE", "SNX", "FORM", "LAB", "HTX", "USDf",
  "CTM", "BDX", "SLX", "UB", "DUCKY", "FRAX", "BILL", "WFI", "KOGE", "ALE",
  "FRXUSD", "USDF", "GOMINING", "VCNT", "GUA", "DUSD", "SMILEK", "0G", "BEAM",
  "MY", "SOON", "REAL", "Q", "AIOZ", "ZIG", "YFI", "TAC", "lisUSD", "CYS",
  "ZAMA", "TRIA", "HUMA", "PLUME", "ZIL", "XPR", "ZETA", "BabyDoge", "NILA",
  "ROSE", "VELO", "UAI", "BRETT", "OPEN", "BSB", "TOSHI", "BAS", "ACH", "AXL",
  "LUR", "ELF", "KAVA", "APR", "IRYS", "EURI", "XUSD", "BARD", "DUSK",
  "SUSHI", "PEAQ", "COAI", "BDCA", "XAUM",
];

export const STABLECOINS = new Set([
  "USDT", "USDC", "DAI", "USD1", "USDe", "USDD", "TUSD", "FDUSD", "USDf",
  "FRAX", "FRXUSD", "USDF", "DUSD", "lisUSD", "EURI", "XUSD", "STABLE",
]);

/** High-momentum eligible tokens — always on watchlist */
export const MOMENTUM_CORE = [
  "FET", "FLOKI", "PENDLE", "INJ", "BONK", "APE", "CAKE", "1INCH", "SNX", "DEXE",
];

/** Rotated in when trending or showing movement */
export const MOMENTUM_VOLATILE = [
  "PENGU", "AXS", "COMP", "LDO", "SUSHI", "RAY", "ZRO", "STG", "NXPC", "CHEEMS",
];

/** Low-beta anchors for stability / hedge */
export const ANCHOR_TOKENS = ["ETH", "LINK", "AVAX"];

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
  return [...MOMENTUM_CORE, ...ANCHOR_TOKENS];
}

export const COMPETITION_CONTRACT = "0x212c61b9b72c95d95bf29cf032f5e5635629aed5";

export const BSC_CHAIN = "bsc";

/** BSC mainnet USDT (BEP-20) — base currency for competition swaps */
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
  const mode = (process.env.AGENT_MODE as "live" | "paper") || "paper";
  const defaultInterval = mode === "paper" ? "30000" : "3600000"; // 30s paper, 60min live

  // Strategy preset supplies risk defaults; explicit env vars still override.
  const strategy = resolveStrategyName(process.env.STRATEGY);
  const profile = getStrategyProfile(strategy);
  const r = profile.risk;
  const num = (env: string | undefined, fallback: number) =>
    env !== undefined && env !== "" ? parseFloat(env) : fallback;

  return {
    mode,
    strategy,
    positionSizeMultiplier: profile.positionSizeMultiplier,
    tradeIntervalMs: parseInt(process.env.TRADE_INTERVAL_MS || defaultInterval, 10),
    maxPositionSizeUsd: num(process.env.MAX_POSITION_SIZE_USD, 100),
    maxDailyTrades: Math.round(num(process.env.MAX_DAILY_TRADES, r.maxDailyTrades)),
    maxDrawdownPct: num(process.env.MAX_DRAWDOWN_PCT, r.maxDrawdownPct),
    slippageTolerance: num(process.env.SLIPPAGE_TOLERANCE, 1),
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

export function isEligibleToken(symbol: string): boolean {
  return ELIGIBLE_TOKENS.includes(symbol.toUpperCase());
}

export function isStablecoin(symbol: string): boolean {
  return STABLECOINS.has(symbol.toUpperCase());
}
