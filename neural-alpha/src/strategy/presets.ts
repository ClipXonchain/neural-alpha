/**
 * Session-aware strategy profiles for 24/7 on-chain bStock trading.
 *
 *   RTH        — NYSE cash hours: trend, ORB, volume; larger size
 *   Close      — 16:00–20:00 ET: harvest overnight premium, hold strength
 *   Overnight  — thin books + news/gaps: mean-reversion, smaller size
 *
 * `auto` policy (default) swaps the active profile as the NY clock moves.
 */

import {
  isSessionPolicy,
  resolveSessionPolicy,
  type SessionName,
  type SessionPolicy,
} from "./session.js";

export type { SessionName, SessionPolicy };

export interface SignalWeights {
  rsi: number;
  macd: number;
  ema: number;
  bollinger: number;
  momentum: number;
  volume: number;
  mcapVolRatio: number;
  news: number;
  stochRsi: number;
  vwap: number;
  gap: number;
  orb: number;
  regime: number;
}

export interface SessionProfile {
  name: SessionName;
  label: string;
  description: string;
  signalWeights: SignalWeights;
  thresholds: {
    strongBuy: number;
    buy: number;
    sell: number;
    strongSell: number;
  };
  alloc: { strongBuy: number; buy: number };
  positionSizeMultiplier: number;
  /** Veto buys into a confirmed downtrend unless RSI+MACD reverse. */
  requireReversalConfirmation: boolean;
  risk: {
    maxDrawdownPct: number;
    maxPortfolioTokens: number;
    minBuyConfidence: number;
    stopLossPct: number;
    takeProfitPct: number;
    trailingActivatePct: number;
    trailingGivebackPct: number;
  };
}

export const SESSION_PROFILES: Record<SessionName, SessionProfile> = {
  rth: {
    name: "rth",
    label: "RTH",
    description:
      "Cash-session price discovery. Trend + opening-range breakouts + volume; larger size, tighter stops.",
    signalWeights: {
      rsi: 8,
      macd: 12,
      ema: 14,
      bollinger: 4,
      momentum: 16,
      volume: 16,
      mcapVolRatio: 6,
      news: 6,
      stochRsi: 6,
      vwap: 10,
      gap: 6,
      orb: 18,
      regime: 12,
    },
    thresholds: { strongBuy: 38, buy: 14, sell: -14, strongSell: -40 },
    alloc: { strongBuy: 20, buy: 11 },
    positionSizeMultiplier: 1.0,
    requireReversalConfirmation: true,
    risk: {
      maxDrawdownPct: 20,
      maxPortfolioTokens: 4,
      minBuyConfidence: 0.5,
      stopLossPct: 6,
      takeProfitPct: 12,
      trailingActivatePct: 12,
      trailingGivebackPct: 1,
    },
  },

  close: {
    name: "close",
    label: "Close",
    description:
      "Harvest overnight equity premium. Accumulate strength into the cash close; do not dump winners just because NYSE closed.",
    signalWeights: {
      rsi: 8,
      macd: 10,
      ema: 14,
      bollinger: 4,
      momentum: 18,
      volume: 10,
      mcapVolRatio: 5,
      news: 8,
      stochRsi: 6,
      vwap: 16,
      gap: 8,
      orb: 0,
      regime: 10,
    },
    thresholds: { strongBuy: 34, buy: 12, sell: -18, strongSell: -44 },
    alloc: { strongBuy: 16, buy: 9 },
    positionSizeMultiplier: 0.85,
    requireReversalConfirmation: false,
    risk: {
      maxDrawdownPct: 22,
      maxPortfolioTokens: 4,
      minBuyConfidence: 0.48,
      stopLossPct: 8,
      takeProfitPct: 16,
      trailingActivatePct: 16,
      trailingGivebackPct: 1,
    },
  },

  overnight: {
    name: "overnight",
    label: "Overnight",
    description:
      "24/7 edge vs cash. Mean-reversion on gaps + news; smaller size, ATR-wider stops. Flatten anytime — cash cannot.",
    signalWeights: {
      rsi: 16,
      macd: 8,
      ema: 8,
      bollinger: 12,
      momentum: 8,
      volume: 6,
      mcapVolRatio: 4,
      news: 14,
      stochRsi: 14,
      vwap: 6,
      gap: 18,
      orb: 0,
      regime: 6,
    },
    thresholds: { strongBuy: 40, buy: 16, sell: -12, strongSell: -38 },
    alloc: { strongBuy: 12, buy: 7 },
    positionSizeMultiplier: 0.55,
    requireReversalConfirmation: false,
    risk: {
      maxDrawdownPct: 18,
      maxPortfolioTokens: 3,
      minBuyConfidence: 0.52,
      stopLossPct: 10,
      takeProfitPct: 14,
      trailingActivatePct: 14,
      trailingGivebackPct: 1,
    },
  },
};

export const DEFAULT_SESSION_POLICY: SessionPolicy = "auto";

/** @deprecated Use SessionName / sessionPolicy. Kept for env alias mapping. */
export type StrategyName = SessionPolicy;

export function getSessionProfile(name: SessionName): SessionProfile {
  return SESSION_PROFILES[name];
}

export function resolveStrategyName(raw?: string | null): SessionPolicy {
  const v = (raw || "").trim().toLowerCase();
  if (v === "safe" || v === "safetrade" || v === "conservative") return "overnight";
  if (v === "medium" || v === "balanced" || v === "mid") return "auto";
  if (v === "momentum" || v === "aggressive" || v === "high") return "rth";
  return resolveSessionPolicy(raw);
}

export function isStrategyName(value: unknown): value is SessionPolicy {
  return isSessionPolicy(value);
}

export function getStrategyProfile(
  name?: SessionPolicy | SessionName | string | null
): SessionProfile {
  const policy = resolveStrategyName(typeof name === "string" ? name : name ?? undefined);
  const active: SessionName = policy === "auto" ? "rth" : policy;
  return SESSION_PROFILES[active];
}
