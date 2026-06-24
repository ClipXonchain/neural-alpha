import type { TechnicalSignals, MarketData, TradeSignal, SignalStrength } from "../utils/types.js";
import { getClosePrices, getVolumes, getPriceHistory } from "../data/market.js";
import { isStablecoin } from "../config.js";
import type { NewsSentiment } from "./news-sentiment.js";
import * as ind from "./indicators.js";
import { logger } from "../utils/logger.js";
import {
  getStrategyProfile,
  DEFAULT_STRATEGY,
  type StrategyProfile,
  type SignalWeights,
} from "./presets.js";

export function computeSignals(symbol: string): TechnicalSignals {
  const closes = getClosePrices(symbol);
  const volumes = getVolumes(symbol);
  const history = getPriceHistory(symbol);

  const highs = history.map((p) => p.high);
  const lows = history.map((p) => p.low);

  const fastEma = ind.latestEma(closes, 12);
  const slowEma = ind.latestEma(closes, 26);

  return {
    rsi: ind.rsi(closes, 14),
    macd: ind.macd(closes, 12, 26, 9),
    ema: fastEma !== null && slowEma !== null ? { fast: fastEma, slow: slowEma } : null,
    bollingerBands: ind.bollingerBands(closes, 20, 2),
    atr: ind.atr(highs, lows, closes, 14),
    volumeRatio: ind.volumeRatio(volumes, 20),
  };
}

interface ScoreComponent {
  name: string;
  /** Maps the component to its weight in the active strategy profile. */
  key: keyof SignalWeights;
  score: number;
  /** Whether this component had enough data to contribute. */
  active: boolean;
  reason: string;
}

function scoreRsi(rsiVal: number | null): ScoreComponent {
  if (rsiVal === null) return { name: "RSI", key: "rsi", score: 0, active: false, reason: "insufficient data" };

  let score = 0;
  let reason = "";
  if (rsiVal < 25) { score = 80; reason = `RSI ${rsiVal.toFixed(1)} — deeply oversold`; }
  else if (rsiVal < 30) { score = 60; reason = `RSI ${rsiVal.toFixed(1)} — oversold`; }
  else if (rsiVal < 40) { score = 30; reason = `RSI ${rsiVal.toFixed(1)} — approaching oversold`; }
  else if (rsiVal > 75) { score = -80; reason = `RSI ${rsiVal.toFixed(1)} — deeply overbought`; }
  else if (rsiVal > 70) { score = -60; reason = `RSI ${rsiVal.toFixed(1)} — overbought`; }
  else if (rsiVal > 60) { score = -20; reason = `RSI ${rsiVal.toFixed(1)} — approaching overbought`; }
  else { score = 0; reason = `RSI ${rsiVal.toFixed(1)} — neutral zone`; }

  return { name: "RSI", key: "rsi", score, active: true, reason };
}

function scoreMacd(macdVal: { macd: number; signal: number; histogram: number } | null): ScoreComponent {
  if (!macdVal) return { name: "MACD", key: "macd", score: 0, active: false, reason: "insufficient data" };

  let score = 0;
  let reason = "";
  if (macdVal.histogram > 0 && macdVal.macd > macdVal.signal) {
    score = macdVal.histogram > 0.01 ? 60 : 30;
    reason = `MACD bullish crossover (hist: ${macdVal.histogram.toFixed(4)})`;
  } else if (macdVal.histogram < 0 && macdVal.macd < macdVal.signal) {
    score = macdVal.histogram < -0.01 ? -60 : -30;
    reason = `MACD bearish crossover (hist: ${macdVal.histogram.toFixed(4)})`;
  } else {
    reason = `MACD neutral (hist: ${macdVal.histogram.toFixed(4)})`;
  }

  return { name: "MACD", key: "macd", score, active: true, reason };
}

function scoreBollinger(
  bb: { upper: number; middle: number; lower: number } | null,
  currentPrice: number
): ScoreComponent {
  if (!bb) return { name: "Bollinger", key: "bollinger", score: 0, active: false, reason: "insufficient data" };

  const range = bb.upper - bb.lower;
  if (range === 0) return { name: "Bollinger", key: "bollinger", score: 0, active: false, reason: "zero range" };

  const position = (currentPrice - bb.lower) / range;
  let score = 0;
  let reason = "";

  if (position < 0.1) { score = 70; reason = `Price below lower BB — potential reversal`; }
  else if (position < 0.25) { score = 40; reason = `Price near lower BB — oversold`; }
  else if (position > 0.9) { score = -70; reason = `Price above upper BB — potential reversal`; }
  else if (position > 0.75) { score = -40; reason = `Price near upper BB — overbought`; }
  else { score = 0; reason = `Price in BB middle zone (${(position * 100).toFixed(0)}%)`; }

  return { name: "Bollinger", key: "bollinger", score, active: true, reason };
}

function scoreEma(emaVal: { fast: number; slow: number } | null): ScoreComponent {
  if (!emaVal) return { name: "EMA", key: "ema", score: 0, active: false, reason: "insufficient data" };

  const diff = ((emaVal.fast - emaVal.slow) / emaVal.slow) * 100;
  let score = 0;
  let reason = "";

  if (diff > 2) { score = 50; reason = `EMA12 > EMA26 by ${diff.toFixed(2)}% — strong uptrend`; }
  else if (diff > 0.5) { score = 30; reason = `EMA12 > EMA26 by ${diff.toFixed(2)}% — uptrend`; }
  else if (diff < -2) { score = -50; reason = `EMA12 < EMA26 by ${Math.abs(diff).toFixed(2)}% — strong downtrend`; }
  else if (diff < -0.5) { score = -30; reason = `EMA12 < EMA26 by ${Math.abs(diff).toFixed(2)}% — downtrend`; }
  else { score = 0; reason = `EMA crossover zone (${diff.toFixed(2)}%)`; }

  return { name: "EMA", key: "ema", score, active: true, reason };
}

function scoreMomentum(symbol: string): ScoreComponent {
  const closes = getClosePrices(symbol);
  const mom = ind.momentum(closes, 10);
  if (mom === null) return { name: "Momentum", key: "momentum", score: 0, active: false, reason: "insufficient data" };

  let score = 0;
  let reason = "";
  if (mom > 10) { score = 40; reason = `Strong positive momentum: +${mom.toFixed(1)}%`; }
  else if (mom > 3) { score = 20; reason = `Positive momentum: +${mom.toFixed(1)}%`; }
  else if (mom < -10) { score = -40; reason = `Strong negative momentum: ${mom.toFixed(1)}%`; }
  else if (mom < -3) { score = -20; reason = `Negative momentum: ${mom.toFixed(1)}%`; }
  else { score = 0; reason = `Flat momentum: ${mom.toFixed(1)}%`; }

  return { name: "Momentum", key: "momentum", score, active: true, reason };
}

function scoreSentiment(fearGreed: number | null): ScoreComponent {
  if (fearGreed === null) return { name: "Sentiment", key: "sentiment", score: 0, active: false, reason: "no F&G data" };

  let score = 0;
  let reason = "";
  // Contrarian: extreme fear = buy, extreme greed = sell
  if (fearGreed < 20) { score = 50; reason = `Extreme Fear (${fearGreed}) — contrarian buy`; }
  else if (fearGreed < 35) { score = 25; reason = `Fear (${fearGreed}) — cautious buy`; }
  else if (fearGreed > 80) { score = -50; reason = `Extreme Greed (${fearGreed}) — contrarian sell`; }
  else if (fearGreed > 65) { score = -25; reason = `Greed (${fearGreed}) — cautious sell`; }
  else { score = 0; reason = `Neutral sentiment (${fearGreed})`; }

  return { name: "Sentiment", key: "sentiment", score, active: true, reason };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function scoreNews(newsSentiment: NewsSentiment | null | undefined): ScoreComponent {
  if (!newsSentiment || newsSentiment.articles === 0) {
    return { name: "News", key: "news", score: 0, active: false, reason: "No news coverage" };
  }

  return {
    name: "News",
    key: "news",
    score: clamp(newsSentiment.score, -100, 100),
    active: true,
    reason: newsSentiment.reasons[0] || `News sentiment (${newsSentiment.articles} articles)`,
  };
}

/**
 * mcap:volume turnover — 24h volume as a fraction of market cap. High turnover
 * means the market is paying outsized attention to the token (often precedes
 * or accompanies a breakout); near-zero turnover flags illiquid / ignored names
 * we'd rather avoid. Liquidity-aware companion to the raw volume-spike signal.
 */
function scoreMcapVolRatio(volume24h?: number, marketCap?: number): ScoreComponent {
  if (!volume24h || !marketCap || marketCap <= 0) {
    return { name: "McapVol", key: "mcapVolRatio", score: 0, active: false, reason: "no mcap/volume data" };
  }

  const turnover = volume24h / marketCap;
  let score = 0;
  let reason = "";
  if (turnover > 0.5) { score = 70; reason = `Turnover ${(turnover * 100).toFixed(0)}% of mcap — heavy interest`; }
  else if (turnover > 0.25) { score = 45; reason = `Turnover ${(turnover * 100).toFixed(0)}% of mcap — strong interest`; }
  else if (turnover > 0.1) { score = 20; reason = `Turnover ${(turnover * 100).toFixed(0)}% of mcap — healthy`; }
  else if (turnover < 0.02) { score = -15; reason = `Turnover ${(turnover * 100).toFixed(1)}% of mcap — thin/illiquid`; }
  else { score = 0; reason = `Turnover ${(turnover * 100).toFixed(1)}% of mcap — normal`; }

  return { name: "McapVol", key: "mcapVolRatio", score, active: true, reason };
}

function scoreVolume(volumeRatio: number | null): ScoreComponent {
  if (volumeRatio === null) {
    return { name: "Volume", key: "volume", score: 0, active: false, reason: "insufficient volume data" };
  }

  let score = 0;
  let reason = "";
  if (volumeRatio > 3) {
    score = 70;
    reason = `Volume spike ${volumeRatio.toFixed(1)}x average`;
  } else if (volumeRatio > 2) {
    score = 50;
    reason = `High volume ${volumeRatio.toFixed(1)}x average`;
  } else if (volumeRatio > 1.5) {
    score = 25;
    reason = `Above-average volume ${volumeRatio.toFixed(1)}x`;
  } else if (volumeRatio < 0.5) {
    score = -30;
    reason = `Low volume ${volumeRatio.toFixed(1)}x average`;
  } else {
    reason = `Normal volume ${volumeRatio.toFixed(1)}x average`;
  }

  return { name: "Volume", key: "volume", score, active: true, reason };
}

function classifyStrength(
  totalScore: number,
  t: StrategyProfile["thresholds"]
): SignalStrength {
  if (totalScore >= t.strongBuy) return "strong_buy";
  if (totalScore >= t.buy) return "buy";
  if (totalScore <= t.strongSell) return "strong_sell";
  if (totalScore <= t.sell) return "sell";
  return "neutral";
}

/**
 * Trend regime gate — protects against "catching a falling knife".
 *
 * A buy is only safe in a confirmed downtrend if there is a genuine reversal
 * signature (deeply oversold RSI + a fresh bullish MACD crossover). Otherwise
 * we veto the buy, which is one of the biggest drawdown-reducers: it stops the
 * agent from repeatedly buying assets that are still trending down.
 */
function isFallingKnife(
  signals: TechnicalSignals,
  symbol: string
): boolean {
  const ema = signals.ema;
  const macd = signals.macd;
  const rsiVal = signals.rsi;
  const mom = ind.momentum(getClosePrices(symbol), 10);

  // Confirmed downtrend: fast EMA well below slow EMA + negative momentum.
  const emaDiffPct = ema ? ((ema.fast - ema.slow) / ema.slow) * 100 : 0;
  const strongDowntrend = emaDiffPct < -1.5 && (mom ?? 0) < -3;
  if (!strongDowntrend) return false;

  // Allow the buy only if a real reversal is forming.
  const bullishReversal =
    rsiVal !== null &&
    rsiVal < 30 &&
    macd !== null &&
    macd.histogram > 0 &&
    macd.macd > macd.signal;

  return !bullishReversal;
}

/** Momentum %, ATR-as-% of price, and volume ratio for watchlist / sizing */
export function getTokenMomentumMetrics(symbol: string): {
  momentum: number | null;
  atrPct: number | null;
  volumeRatio: number | null;
} {
  const closes = getClosePrices(symbol);
  const history = getPriceHistory(symbol);
  const volumes = getVolumes(symbol);
  const mom = ind.momentum(closes, 10);
  const highs = history.map((p) => p.high);
  const lows = history.map((p) => p.low);
  const atrVal = ind.atr(highs, lows, closes, 14);
  const price = closes.length > 0 ? closes[closes.length - 1] : null;
  const atrPct =
    atrVal !== null && price !== null && price > 0 ? (atrVal / price) * 100 : null;
  const volumeRatio = ind.volumeRatio(volumes, 20);
  return { momentum: mom, atrPct, volumeRatio };
}

/** Normalized metrics for dashboard display (MACD %, BB position, VWAP deviation). */
export function getTokenDisplayMetrics(
  symbol: string,
  price?: number | null
): {
  macdPct: number | null;
  bbPosition: number | null;
  vwapDev: number | null;
} {
  const closes = getClosePrices(symbol);
  const history = getPriceHistory(symbol);
  const tech = computeSignals(symbol);
  const p = price ?? closes.at(-1) ?? null;

  const macdPct =
    tech.macd && p && p > 0 ? (tech.macd.histogram / p) * 100 : null;

  const bb = tech.bollingerBands;
  const bbPosition =
    bb && p && bb.upper !== bb.lower
      ? ((p - bb.lower) / (bb.upper - bb.lower)) * 100
      : null;

  const vwapVal = ind.vwap(history);
  const vwapDev =
    vwapVal && p && vwapVal > 0 ? ((p - vwapVal) / vwapVal) * 100 : null;

  return { macdPct, bbPosition, vwapDev };
}

export function generateSignal(
  market: MarketData,
  signals: TechnicalSignals,
  fearGreed: number | null,
  newsSentiment?: NewsSentiment | null,
  strategy?: StrategyProfile | string | null
): TradeSignal {
  const profile =
    strategy && typeof strategy === "object"
      ? strategy
      : getStrategyProfile(strategy ?? DEFAULT_STRATEGY);
  const weights = profile.signalWeights;

  if (isStablecoin(market.symbol)) {
    return {
      symbol: market.symbol,
      action: "hold",
      strength: "neutral",
      score: 0,
      reasons: ["Stablecoin — not a trading candidate"],
      targetAllocationPct: 0,
      confidence: 1,
    };
  }

  const components: ScoreComponent[] = [
    scoreRsi(signals.rsi),
    scoreMacd(signals.macd),
    scoreBollinger(signals.bollingerBands, market.price),
    scoreEma(signals.ema),
    scoreMomentum(market.symbol),
    scoreVolume(signals.volumeRatio),
    scoreMcapVolRatio(market.volume24h, market.marketCap),
    scoreSentiment(fearGreed),
    scoreNews(newsSentiment),
  ];

  // Active components weighted by the chosen strategy profile.
  const activeComponents = components.filter((c) => c.active && weights[c.key] > 0);
  const totalWeight = activeComponents.reduce((s, c) => s + weights[c.key], 0);

  let totalScore = 0;
  if (totalWeight > 0) {
    totalScore = activeComponents.reduce(
      (s, c) => s + (c.score * weights[c.key]) / totalWeight,
      0
    );
  }

  let strength = classifyStrength(totalScore, profile.thresholds);
  let action: TradeSignal["action"] =
    strength === "strong_buy" || strength === "buy"
      ? "buy"
      : strength === "strong_sell" || strength === "sell"
        ? "sell"
        : "hold";

  const reasons = activeComponents.map((c) => c.reason);

  // Safety gate: never buy into a confirmed downtrend without reversal proof.
  // SafeTrade/Medium enforce it; Momentum allows earlier breakout entries.
  if (
    action === "buy" &&
    profile.requireReversalConfirmation &&
    isFallingKnife(signals, market.symbol)
  ) {
    action = "hold";
    strength = "neutral";
    totalScore = Math.min(totalScore, 0);
    reasons.unshift("Buy vetoed — confirmed downtrend, no reversal confirmation");
  }

  // Confidence scales with how much of the strategy's weight is backed by data.
  const totalProfileWeight = components.reduce((s, c) => s + weights[c.key], 0);
  const confidence = totalProfileWeight > 0
    ? Math.min(1, totalWeight / totalProfileWeight + 0.15)
    : 0;

  let targetAllocation = 0;
  if (action === "buy") {
    targetAllocation = strength === "strong_buy" ? profile.alloc.strongBuy : profile.alloc.buy;
  }

  logger.signal("Signal generated", {
    symbol: market.symbol,
    strategy: profile.name,
    score: Math.round(totalScore),
    strength,
    action,
    confidence: Math.round(confidence * 100),
  });

  return {
    symbol: market.symbol,
    action,
    strength,
    score: totalScore,
    reasons,
    targetAllocationPct: targetAllocation,
    confidence,
  };
}
