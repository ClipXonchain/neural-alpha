import type { AgentConfig } from "./utils/types.js";

export const ELIGIBLE_TOKENS: string[] = [
  "ETH", "USDT", "USDC", "XRP", "TRX", "DOGE", "ZEC", "ADA", "LINK", "BCH",
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

export function loadConfig(): AgentConfig {
  const mode = (process.env.AGENT_MODE as "live" | "paper") || "paper";
  const defaultInterval = mode === "paper" ? "30000" : "300000"; // 30s paper, 5min live
  return {
    mode,
    tradeIntervalMs: parseInt(process.env.TRADE_INTERVAL_MS || defaultInterval, 10),
    maxPositionSizeUsd: parseFloat(process.env.MAX_POSITION_SIZE_USD || "100"),
    maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || "10", 10),
    maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN_PCT || "25"),
    slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE || "1.5"),
    baseCurrency: process.env.BASE_CURRENCY || "USDT",
    maxPortfolioTokens: 5,
    minTradeAmountUsd: 5,
    rebalanceThresholdPct: 10,
  };
}

export function isEligibleToken(symbol: string): boolean {
  return ELIGIBLE_TOKENS.includes(symbol.toUpperCase());
}

export function isStablecoin(symbol: string): boolean {
  return STABLECOINS.has(symbol.toUpperCase());
}
