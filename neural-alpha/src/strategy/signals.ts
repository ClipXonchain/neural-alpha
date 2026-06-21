import type { TechnicalSignals, MarketData, TradeSignal, SignalStrength } from "../utils/types.js";
import { getClosePrices, getVolumes, getPriceHistory } from "../data/market.js";
import { isStablecoin } from "../config.js";
import type { NewsSentiment } from "./news-sentiment.js";
import * as ind from "./indicators.js";
import { logger } from "../utils/logger.js";

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
  score: number;
  weight: number;
  reason: string;
}

function scoreRsi(rsiVal: number | null): ScoreComponent {
  if (rsiVal === null) return { name: "RSI", score: 0, weight: 0, reason: "insufficient data" };

  let score = 0;
  let reason = "";
  if (rsiVal < 25) { score = 80; reason = `RSI ${rsiVal.toFixed(1)} — deeply oversold`; }
  else if (rsiVal < 30) { score = 60; reason = `RSI ${rsiVal.toFixed(1)} — oversold`; }
  else if (rsiVal < 40) { score = 30; reason = `RSI ${rsiVal.toFixed(1)} — approaching oversold`; }
  else if (rsiVal > 75) { score = -80; reason = `RSI ${rsiVal.toFixed(1)} — deeply overbought`; }
  else if (rsiVal > 70) { score = -60; reason = `RSI ${rsiVal.toFixed(1)} — overbought`; }
  else if (rsiVal > 60) { score = -20; reason = `RSI ${rsiVal.toFixed(1)} — approaching overbought`; }
  else { score = 0; reason = `RSI ${rsiVal.toFixed(1)} — neutral zone`; }

  return { name: "RSI", score, weight: 17, reason };
}

function scoreMacd(macdVal: { macd: number; signal: number; histogram: number } | null): ScoreComponent {
  if (!macdVal) return { name: "MACD", score: 0, weight: 0, reason: "insufficient data" };

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

  return { name: "MACD", score, weight: 17, reason };
}

function scoreBollinger(
  bb: { upper: number; middle: number; lower: number } | null,
  currentPrice: number
): ScoreComponent {
  if (!bb) return { name: "Bollinger", score: 0, weight: 0, reason: "insufficient data" };

  const range = bb.upper - bb.lower;
  if (range === 0) return { name: "Bollinger", score: 0, weight: 8, reason: "zero range" };

  const position = (currentPrice - bb.lower) / range;
  let score = 0;
  let reason = "";

  if (position < 0.1) { score = 70; reason = `Price below lower BB — potential reversal`; }
  else if (position < 0.25) { score = 40; reason = `Price near lower BB — oversold`; }
  else if (position > 0.9) { score = -70; reason = `Price above upper BB — potential reversal`; }
  else if (position > 0.75) { score = -40; reason = `Price near upper BB — overbought`; }
  else { score = 0; reason = `Price in BB middle zone (${(position * 100).toFixed(0)}%)`; }

  return { name: "Bollinger", score, weight: 8, reason };
}

function scoreEma(emaVal: { fast: number; slow: number } | null): ScoreComponent {
  if (!emaVal) return { name: "EMA", score: 0, weight: 0, reason: "insufficient data" };

  const diff = ((emaVal.fast - emaVal.slow) / emaVal.slow) * 100;
  let score = 0;
  let reason = "";

  if (diff > 2) { score = 50; reason = `EMA12 > EMA26 by ${diff.toFixed(2)}% — strong uptrend`; }
  else if (diff > 0.5) { score = 30; reason = `EMA12 > EMA26 by ${diff.toFixed(2)}% — uptrend`; }
  else if (diff < -2) { score = -50; reason = `EMA12 < EMA26 by ${Math.abs(diff).toFixed(2)}% — strong downtrend`; }
  else if (diff < -0.5) { score = -30; reason = `EMA12 < EMA26 by ${Math.abs(diff).toFixed(2)}% — downtrend`; }
  else { score = 0; reason = `EMA crossover zone (${diff.toFixed(2)}%)`; }

  return { name: "EMA", score, weight: 13, reason };
}

function scoreMomentum(symbol: string): ScoreComponent {
  const closes = getClosePrices(symbol);
  const mom = ind.momentum(closes, 10);
  if (mom === null) return { name: "Momentum", score: 0, weight: 0, reason: "insufficient data" };

  let score = 0;
  let reason = "";
  if (mom > 10) { score = 40; reason = `Strong positive momentum: +${mom.toFixed(1)}%`; }
  else if (mom > 3) { score = 20; reason = `Positive momentum: +${mom.toFixed(1)}%`; }
  else if (mom < -10) { score = -40; reason = `Strong negative momentum: ${mom.toFixed(1)}%`; }
  else if (mom < -3) { score = -20; reason = `Negative momentum: ${mom.toFixed(1)}%`; }
  else { score = 0; reason = `Flat momentum: ${mom.toFixed(1)}%`; }

  return { name: "Momentum", score, weight: 22, reason };
}

function scoreSentiment(fearGreed: number | null): ScoreComponent {
  if (fearGreed === null) return { name: "Sentiment", score: 0, weight: 0, reason: "no F&G data" };

  let score = 0;
  let reason = "";
  // Contrarian: extreme fear = buy, extreme greed = sell
  if (fearGreed < 20) { score = 50; reason = `Extreme Fear (${fearGreed}) — contrarian buy`; }
  else if (fearGreed < 35) { score = 25; reason = `Fear (${fearGreed}) — cautious buy`; }
  else if (fearGreed > 80) { score = -50; reason = `Extreme Greed (${fearGreed}) — contrarian sell`; }
  else if (fearGreed > 65) { score = -25; reason = `Greed (${fearGreed}) — cautious sell`; }
  else { score = 0; reason = `Neutral sentiment (${fearGreed})`; }

  return { name: "Sentiment", score, weight: 8, reason };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function scoreNews(newsSentiment: NewsSentiment | null | undefined): ScoreComponent {
  if (!newsSentiment || newsSentiment.articles === 0) {
    return { name: "News", score: 0, weight: 0, reason: "No news coverage" };
  }

  return {
    name: "News",
    score: clamp(newsSentiment.score, -100, 100),
    weight: 15,
    reason: newsSentiment.reasons[0] || `News sentiment (${newsSentiment.articles} articles)`,
  };
}

function classifyStrength(totalScore: number): SignalStrength {
  if (totalScore >= 40) return "strong_buy";
  if (totalScore >= 15) return "buy";
  if (totalScore <= -40) return "strong_sell";
  if (totalScore <= -10) return "sell"; // faster exit on reversals (was -15)
  return "neutral";
}

/** Momentum % and ATR-as-% of price for watchlist / sizing */
export function getTokenMomentumMetrics(symbol: string): {
  momentum: number | null;
  atrPct: number | null;
} {
  const closes = getClosePrices(symbol);
  const history = getPriceHistory(symbol);
  const mom = ind.momentum(closes, 10);
  const highs = history.map((p) => p.high);
  const lows = history.map((p) => p.low);
  const atrVal = ind.atr(highs, lows, closes, 14);
  const price = closes.length > 0 ? closes[closes.length - 1] : null;
  const atrPct =
    atrVal !== null && price !== null && price > 0 ? (atrVal / price) * 100 : null;
  return { momentum: mom, atrPct };
}

export function generateSignal(
  market: MarketData,
  signals: TechnicalSignals,
  fearGreed: number | null,
  newsSentiment?: NewsSentiment | null
): TradeSignal {
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
    scoreSentiment(fearGreed),
    scoreNews(newsSentiment),
  ];

  const activeComponents = components.filter((c) => c.weight > 0);
  const totalWeight = activeComponents.reduce((s, c) => s + c.weight, 0);

  let totalScore = 0;
  if (totalWeight > 0) {
    totalScore = activeComponents.reduce((s, c) => s + (c.score * c.weight) / totalWeight, 0);
  }

  const strength = classifyStrength(totalScore);
  const action =
    strength === "strong_buy" || strength === "buy"
      ? "buy"
      : strength === "strong_sell" || strength === "sell"
        ? "sell"
        : "hold";

  const confidence = Math.min(1, activeComponents.length / 6);

  let targetAllocation = 0;
  if (action === "buy") {
    targetAllocation = strength === "strong_buy" ? 20 : 10;
  }

  const reasons = activeComponents.map((c) => c.reason);

  logger.signal("Signal generated", {
    symbol: market.symbol,
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
