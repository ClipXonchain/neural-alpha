/**
 * Strategy presets — three risk-tiered day-trading profiles.
 *
 *   SafeTrade  <  Medium  <  Momentum
 *   (lowest DD / lowest ROI)        (highest ROI / highest DD chance)
 *
 * Each profile bundles two things:
 *   1. `signalWeights` — how much each indicator contributes to the blended
 *      score. This is the "priority weighting" the strategy trades on
 *      (volume spike, mcap:volume turnover, 24h momentum, RSI, MACD, etc.).
 *   2. Risk parameters — drawdown cap, stop/take-profit, position sizing,
 *      and how many trades/positions are allowed.
 *
 * Designed for top-150 CMC day trading at ~1–5 trades/day. SafeTrade favours
 * confirmed mean-reversion with tight stops; Momentum chases breakouts/volume
 * with wider stops and lets winners run.
 */

export type StrategyName = "safe" | "medium" | "momentum";

export interface SignalWeights {
  rsi: number;
  macd: number;
  ema: number;
  bollinger: number;
  momentum: number;
  /** Relative volume vs its own 20-bar average (volume spike). */
  volume: number;
  /** 24h volume / market cap — turnover / liquidity-adjusted interest. */
  mcapVolRatio: number;
  sentiment: number;
  news: number;
}

export interface StrategyProfile {
  name: StrategyName;
  label: string;
  description: string;

  signalWeights: SignalWeights;

  /** Blended-score thresholds that map to buy/sell strength. */
  thresholds: {
    strongBuy: number;
    buy: number;
    sell: number;
    strongSell: number;
  };

  /** Target portfolio allocation (%) per new position. */
  alloc: { strongBuy: number; buy: number };

  /** Multiplier applied to the computed position size (sizing aggressiveness). */
  positionSizeMultiplier: number;

  /** Require an oversold + bullish-MACD reversal before buying a downtrend. */
  requireReversalConfirmation: boolean;

  /** Risk guardrails fed into AgentConfig. */
  risk: {
    maxDrawdownPct: number;
    maxDailyTrades: number;
    maxPortfolioTokens: number;
    minBuyConfidence: number;
    stopLossPct: number;
    takeProfitPct: number;
    trailingActivatePct: number;
    trailingGivebackPct: number;
  };
}

export const STRATEGY_PRESETS: Record<StrategyName, StrategyProfile> = {
  /**
   * SafeTrade — capital-preservation first. Leans on mean-reversion (RSI,
   * Bollinger) + trend/sentiment confirmation, doesn't chase volume spikes,
   * needs high conviction to act, and cuts losers fast with tight stops.
   * Fewer trades, smaller size, lowest expected drawdown.
   */
  safe: {
    name: "safe",
    label: "SafeTrade",
    description:
      "Capital-preservation. Confirmed mean-reversion, tight stops, smallest size — lowest drawdown, steadier but smaller ROI.",
    signalWeights: {
      rsi: 22,
      macd: 14,
      ema: 14,
      bollinger: 12,
      momentum: 8,
      volume: 8,
      mcapVolRatio: 4,
      sentiment: 10,
      news: 8,
    },
    thresholds: { strongBuy: 45, buy: 24, sell: -15, strongSell: -42 },
    alloc: { strongBuy: 14, buy: 7 },
    positionSizeMultiplier: 0.6,
    requireReversalConfirmation: true,
    risk: {
      maxDrawdownPct: 12,
      maxDailyTrades: 3,
      maxPortfolioTokens: 3,
      minBuyConfidence: 0.65,
      stopLossPct: 5,
      takeProfitPct: 10,
      trailingActivatePct: 4,
      trailingGivebackPct: 2,
    },
  },

  /**
   * Medium — balanced day-trading profile. Equal respect for trend, momentum
   * and volume, with moderate stops and sizing. The sensible default.
   */
  medium: {
    name: "medium",
    label: "Medium",
    description:
      "Balanced. Trend + momentum + volume weighted evenly, moderate stops and sizing — middle ground on risk and return.",
    signalWeights: {
      rsi: 15,
      macd: 13,
      ema: 11,
      bollinger: 6,
      momentum: 18,
      volume: 18,
      mcapVolRatio: 7,
      sentiment: 6,
      news: 10,
    },
    thresholds: { strongBuy: 40, buy: 15, sell: -12, strongSell: -40 },
    alloc: { strongBuy: 18, buy: 10 },
    positionSizeMultiplier: 0.85,
    requireReversalConfirmation: true,
    risk: {
      maxDrawdownPct: 20,
      maxDailyTrades: 5,
      maxPortfolioTokens: 3,
      minBuyConfidence: 0.55,
      stopLossPct: 8,
      takeProfitPct: 15,
      trailingActivatePct: 6,
      trailingGivebackPct: 3,
    },
  },

  /**
   * Momentum — return-seeking. Heavily weights volume spikes, momentum and
   * mcap:volume turnover to catch breakouts early; de-emphasises overbought
   * RSI so it can ride trends. Wider stops, larger size, higher take-profit
   * and a looser reversal gate. Highest ROI potential and highest DD risk.
   */
  momentum: {
    name: "momentum",
    label: "Momentum",
    description:
      "Return-seeking. Chases volume spikes, momentum and turnover breakouts; wider stops, larger size, lets winners run — highest ROI, highest drawdown risk.",
    signalWeights: {
      rsi: 8,
      macd: 12,
      ema: 12,
      bollinger: 4,
      momentum: 26,
      volume: 26,
      mcapVolRatio: 12,
      sentiment: 2,
      news: 8,
    },
    thresholds: { strongBuy: 35, buy: 12, sell: -12, strongSell: -42 },
    alloc: { strongBuy: 24, buy: 13 },
    positionSizeMultiplier: 1.1,
    requireReversalConfirmation: false,
    risk: {
      maxDrawdownPct: 28,
      maxDailyTrades: 6,
      maxPortfolioTokens: 3,
      minBuyConfidence: 0.45,
      stopLossPct: 10,
      takeProfitPct: 28,
      trailingActivatePct: 8,
      trailingGivebackPct: 4,
    },
  },
};

export const DEFAULT_STRATEGY: StrategyName = "medium";

export function isStrategyName(value: unknown): value is StrategyName {
  return value === "safe" || value === "medium" || value === "momentum";
}

export function resolveStrategyName(raw?: string | null): StrategyName {
  const v = (raw || "").trim().toLowerCase();
  if (isStrategyName(v)) return v;
  // Friendly aliases.
  if (v === "safetrade" || v === "conservative" || v === "low") return "safe";
  if (v === "balanced" || v === "mid") return "medium";
  if (v === "aggressive" || v === "high" || v === "momentum") return "momentum";
  return DEFAULT_STRATEGY;
}

export function getStrategyProfile(name?: StrategyName | string | null): StrategyProfile {
  return STRATEGY_PRESETS[resolveStrategyName(typeof name === "string" ? name : name ?? undefined)];
}
