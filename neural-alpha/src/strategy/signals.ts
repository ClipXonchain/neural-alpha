import type { TechnicalSignals, MarketData, TradeSignal, SignalStrength } from "../utils/types.js";
import { getClosePrices, getVolumes, getPriceHistory } from "../data/market.js";
import { isStablecoin } from "../config.js";
import type { NewsSentiment } from "./news-sentiment.js";
import type { CmcMacroSnapshot } from "./cmc-macro.js";
import * as ind from "./indicators.js";
import {
  getSessionProfile,
  type SessionName,
  type SessionProfile,
  type SignalWeights,
} from "./presets.js";
import {
  clockSession,
  getSessionClock,
  openingRange,
  overnightGapPct,
  type SessionPolicy,
} from "./session.js";

export type IndexRegime = "risk_on" | "risk_off" | "neutral";

export function computeSignals(symbol: string, price?: number): TechnicalSignals {
  const closes = getClosePrices(symbol);
  const volumes = getVolumes(symbol);
  const history = getPriceHistory(symbol);

  const highs = history.map((p) => p.high);
  const lows = history.map((p) => p.low);

  const fastEma = ind.latestEma(closes, 12);
  const slowEma = ind.latestEma(closes, 26);
  const atrVal = ind.atr(highs, lows, closes, 14);
  const lastClose = price ?? (closes.length > 0 ? closes[closes.length - 1] : null);
  const atrPct =
    atrVal !== null && lastClose !== null && lastClose > 0 ? (atrVal / lastClose) * 100 : null;
  const gapPct = lastClose != null ? overnightGapPct(lastClose, history) : null;
  const orb = lastClose != null ? openingRange(history, lastClose) : null;
  const vwapVal = ind.vwap(history);

  return {
    rsi: ind.rsi(closes, 14),
    macd: ind.macd(closes, 12, 26, 9),
    ema: fastEma !== null && slowEma !== null ? { fast: fastEma, slow: slowEma } : null,
    bollingerBands: ind.bollingerBands(closes, 20, 2),
    atr: atrVal,
    volumeRatio: ind.volumeRatio(volumes, 20),
    stochRsi: ind.stochRsi(closes, 14, 14),
    vwap: vwapVal,
    gapPct,
    orb,
    atrPct,
  };
}

interface ScoreComponent {
  name: string;
  key: keyof SignalWeights;
  score: number;
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

function scoreStochRsi(val: number | null): ScoreComponent {
  if (val === null) {
    return { name: "StochRSI", key: "stochRsi", score: 0, active: false, reason: "insufficient data" };
  }
  let score = 0;
  let reason = "";
  if (val < 15) { score = 70; reason = `StochRSI ${val.toFixed(0)} — extreme oversold`; }
  else if (val < 25) { score = 45; reason = `StochRSI ${val.toFixed(0)} — oversold`; }
  else if (val > 85) { score = -70; reason = `StochRSI ${val.toFixed(0)} — extreme overbought`; }
  else if (val > 75) { score = -45; reason = `StochRSI ${val.toFixed(0)} — overbought`; }
  else { score = 0; reason = `StochRSI ${val.toFixed(0)} — mid range`; }
  return { name: "StochRSI", key: "stochRsi", score, active: true, reason };
}

function scoreVwap(vwap: number | null, price: number, session: SessionName): ScoreComponent {
  if (vwap === null || !(price > 0) || vwap <= 0) {
    return { name: "VWAP", key: "vwap", score: 0, active: false, reason: "no VWAP" };
  }
  const dev = ((price - vwap) / vwap) * 100;
  let score = 0;
  let reason = "";
  if (session === "close") {
    // Hold/add strength above VWAP into the cash close (overnight premium).
    if (dev > 0.4) { score = 45; reason = `+${dev.toFixed(2)}% vs VWAP — strength into close`; }
    else if (dev < -0.8) { score = -35; reason = `${dev.toFixed(2)}% vs VWAP — weak into close`; }
    else { reason = `${dev.toFixed(2)}% vs VWAP — close tape`; }
  } else if (session === "overnight") {
    // Fade extended VWAP prints overnight when books are thin.
    if (dev > 1.5) { score = -40; reason = `${dev.toFixed(2)}% above VWAP — fade overnight extension`; }
    else if (dev < -1.5) { score = 40; reason = `${dev.toFixed(2)}% below VWAP — overnight mean-revert`; }
    else { reason = `${dev.toFixed(2)}% vs VWAP`; }
  } else {
    if (dev > 0.3) { score = 30; reason = `+${dev.toFixed(2)}% vs VWAP — RTH bid`; }
    else if (dev < -0.3) { score = -25; reason = `${dev.toFixed(2)}% vs VWAP — RTH offer`; }
    else { reason = `${dev.toFixed(2)}% vs VWAP`; }
  }
  return { name: "VWAP", key: "vwap", score, active: true, reason };
}

function scoreGap(gapPct: number | null, session: SessionName): ScoreComponent {
  if (gapPct === null) {
    return { name: "Gap", key: "gap", score: 0, active: false, reason: "no RTH close ref" };
  }
  const mag = Math.abs(gapPct);
  let score = 0;
  let reason = "";
  if (session === "overnight" || session === "close") {
    // Fade extreme gaps; follow modest overnight drift.
    if (gapPct <= -2.5) { score = 55; reason = `Gap ${gapPct.toFixed(2)}% vs RTH close — fade the dump`; }
    else if (gapPct <= -1) { score = 30; reason = `Gap ${gapPct.toFixed(2)}% vs RTH close — overnight dip`; }
    else if (gapPct >= 2.5) { score = -50; reason = `Gap +${gapPct.toFixed(2)}% vs RTH close — fade the spike`; }
    else if (gapPct >= 0.6) { score = 20; reason = `Gap +${gapPct.toFixed(2)}% — overnight premium`; }
    else { reason = `Gap ${gapPct.toFixed(2)}% vs RTH close`; }
  } else {
    if (mag < 0.3) { reason = `Gap ${gapPct.toFixed(2)}% — filled / flat`; }
    else if (gapPct > 0) { score = Math.min(40, 12 + mag * 6); reason = `Gap +${gapPct.toFixed(2)}% — follow RTH continuation`; }
    else { score = Math.max(-40, -12 - mag * 6); reason = `Gap ${gapPct.toFixed(2)}% — RTH gap-down pressure`; }
  }
  return { name: "Gap", key: "gap", score, active: true, reason };
}

function scoreOrb(
  orb: TechnicalSignals["orb"],
  session: SessionName
): ScoreComponent {
  if (session !== "rth") {
    return { name: "ORB", key: "orb", score: 0, active: false, reason: "ORB only in RTH" };
  }
  if (!orb) {
    return { name: "ORB", key: "orb", score: 0, active: false, reason: "opening range not ready" };
  }
  const b = orb.breakoutPct;
  let score = 0;
  let reason = "";
  if (b > 0.35) { score = 65; reason = `ORB breakout +${b.toFixed(2)}% above 09:30–10:00 ET`; }
  else if (b > 0.08) { score = 30; reason = `ORB probe +${b.toFixed(2)}%`; }
  else if (b < -0.35) { score = -65; reason = `ORB breakdown ${b.toFixed(2)}% below opening range`; }
  else if (b < -0.08) { score = -30; reason = `ORB weak ${b.toFixed(2)}%`; }
  else { reason = `Inside opening range`; }
  return { name: "ORB", key: "orb", score, active: true, reason };
}

function scoreRegime(
  regime: IndexRegime,
  session: SessionName,
  cmc?: CmcMacroSnapshot | null
): ScoreComponent {
  const tape = cmc ? "SPY/QQQ+CMC" : "SPYB/QQQB";
  if (regime === "neutral") {
    return {
      name: "Regime",
      key: "regime",
      score: 0,
      active: true,
      reason: cmc ? `${tape} mixed (${cmc.summary})` : `${tape} regime mixed`,
    };
  }
  const rthBoost = session === "rth" ? 1 : 0.55;
  if (regime === "risk_on") {
    return {
      name: "Regime",
      key: "regime",
      score: Math.round(35 * rthBoost),
      active: true,
      reason: `${tape} risk-on — follow longs`,
    };
  }
  return {
    name: "Regime",
    key: "regime",
    score: Math.round(-45 * (session === "rth" ? 1 : 0.7)),
    active: true,
    reason: `${tape} risk-off — cut new longs`,
  };
}

function classifyStrength(
  totalScore: number,
  t: SessionProfile["thresholds"]
): SignalStrength {
  if (totalScore >= t.strongBuy) return "strong_buy";
  if (totalScore >= t.buy) return "buy";
  if (totalScore <= t.strongSell) return "strong_sell";
  if (totalScore <= t.sell) return "sell";
  return "neutral";
}

function isFallingKnife(signals: TechnicalSignals, symbol: string): boolean {
  const ema = signals.ema;
  const macd = signals.macd;
  const rsiVal = signals.rsi;
  const mom = ind.momentum(getClosePrices(symbol), 10);

  const emaDiffPct = ema ? ((ema.fast - ema.slow) / ema.slow) * 100 : 0;
  const strongDowntrend = emaDiffPct < -1.5 && (mom ?? 0) < -3;
  if (!strongDowntrend) return false;

  const bullishReversal =
    rsiVal !== null &&
    rsiVal < 30 &&
    macd !== null &&
    macd.histogram > 0 &&
    macd.macd > macd.signal;

  return !bullishReversal;
}

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

type DisplayMetrics = {
  rsi: number | null;
  macdPct: number | null;
  bbPosition: number | null;
  vwapDev: number | null;
  stochRsi: number | null;
  gapPct: number | null;
  orbBreakoutPct: number | null;
  atrPct: number | null;
};

const DISPLAY_CACHE_MS = 8_000;
const displayCache = new Map<string, { at: number; price: number; value: DisplayMetrics }>();

export function getTokenDisplayMetrics(
  symbol: string,
  price?: number | null
): DisplayMetrics {
  const p = price ?? 0;
  const hit = displayCache.get(symbol);
  if (
    hit &&
    Date.now() - hit.at < DISPLAY_CACHE_MS &&
    (p <= 0 || hit.price <= 0 || Math.abs(p - hit.price) / hit.price < 0.003)
  ) {
    return hit.value;
  }

  const closes = getClosePrices(symbol);
  const tech = computeSignals(symbol, price ?? undefined);
  const last = price ?? closes.at(-1) ?? null;

  const macdPct =
    tech.macd && last && last > 0 ? (tech.macd.histogram / last) * 100 : null;

  const bb = tech.bollingerBands;
  const bbPosition =
    bb && last && bb.upper !== bb.lower
      ? ((last - bb.lower) / (bb.upper - bb.lower)) * 100
      : null;

  const vwapDev =
    tech.vwap && last && tech.vwap > 0 ? ((last - tech.vwap) / tech.vwap) * 100 : null;

  const value: DisplayMetrics = {
    rsi: tech.rsi !== null ? Math.round(tech.rsi * 10) / 10 : null,
    macdPct,
    bbPosition,
    vwapDev,
    stochRsi: tech.stochRsi,
    gapPct: tech.gapPct,
    orbBreakoutPct: tech.orb?.breakoutPct ?? null,
    atrPct: tech.atrPct,
  };
  displayCache.set(symbol, { at: Date.now(), price: p, value });
  return value;
}

export function computeIndexRegime(markets: MarketData[]): IndexRegime {
  const spy = markets.find((m) => m.symbol.toUpperCase() === "SPYB");
  const qqq = markets.find((m) => m.symbol.toUpperCase() === "QQQB");
  const spyTech = computeSignals("SPYB", spy?.price);
  const qqqTech = computeSignals("QQQB", qqq?.price);

  const spyChg = spy?.change24h ?? ind.momentum(getClosePrices("SPYB"), 10) ?? 0;
  const qqqChg = qqq?.change24h ?? ind.momentum(getClosePrices("QQQB"), 10) ?? 0;
  const spyUp = spyTech.ema ? spyTech.ema.fast > spyTech.ema.slow : spyChg > 0;
  const qqqUp = qqqTech.ema ? qqqTech.ema.fast > qqqTech.ema.slow : qqqChg > 0;

  if (spyChg <= -1.2 && qqqChg <= -1.2 && !spyUp && !qqqUp) return "risk_off";
  if (spyChg >= 0.6 && qqqChg >= 0.6 && spyUp && qqqUp) return "risk_on";
  return "neutral";
}

export function generateSignal(
  market: MarketData,
  signals: TechnicalSignals,
  newsSentiment?: NewsSentiment | null,
  session?: SessionName | SessionPolicy | SessionProfile | null,
  regime: IndexRegime = "neutral",
  cmc?: CmcMacroSnapshot | null
): TradeSignal {
  const sessionName: SessionName =
    session && typeof session === "object" && "name" in session
      ? session.name
      : session === "auto" || !session
        ? clockSession()
        : (session as SessionName);
  const profile =
    session && typeof session === "object" && "signalWeights" in session
      ? session
      : getSessionProfile(sessionName);
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
      session: sessionName,
      gapPct: signals.gapPct,
      stochRsi: signals.stochRsi,
      atrPct: signals.atrPct,
      vwapDev:
        signals.vwap && market.price > 0 && signals.vwap > 0
          ? ((market.price - signals.vwap) / signals.vwap) * 100
          : null,
      orbBreakoutPct: signals.orb?.breakoutPct ?? null,
      regime,
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
    scoreNews(newsSentiment),
    scoreStochRsi(signals.stochRsi),
    scoreVwap(signals.vwap, market.price, sessionName),
    scoreGap(signals.gapPct, sessionName),
    scoreOrb(signals.orb, sessionName),
    scoreRegime(regime, sessionName, cmc),
  ];

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

  if (action === "buy" && regime === "risk_off" && sessionName === "rth" && strength !== "strong_buy") {
    action = "hold";
    strength = "neutral";
    reasons.unshift("Buy vetoed — SPY/QQQ risk-off in RTH");
  }

  if (action === "buy" && cmc?.regime === "risk_off" && strength !== "strong_buy") {
    action = "hold";
    strength = "neutral";
    totalScore = Math.min(totalScore, 0);
    reasons.unshift(`Buy vetoed — CMC crypto tape risk-off (${cmc.summary})`);
  }

  if (action === "buy" && cmc?.eventRisk === "high" && strength !== "strong_buy") {
    action = "hold";
    strength = "neutral";
    totalScore = Math.min(totalScore, 0);
    reasons.unshift(
      `Buy vetoed — CMC macro event in next 48h${cmc.eventHint ? `: ${cmc.eventHint}` : ""}`
    );
  }

  const totalProfileWeight = components.reduce((s, c) => s + weights[c.key], 0);
  const confidence = totalProfileWeight > 0
    ? Math.min(1, totalWeight / totalProfileWeight + 0.15)
    : 0;

  let targetAllocation = 0;
  if (action === "buy") {
    targetAllocation = strength === "strong_buy" ? profile.alloc.strongBuy : profile.alloc.buy;
    if (cmc && cmc.sizeScale > 0 && cmc.sizeScale !== 1) {
      targetAllocation *= cmc.sizeScale;
      reasons.push(`CMC size scale ${cmc.sizeScale.toFixed(2)}x`);
    }
  }

  const vwapDev =
    signals.vwap && market.price > 0 && signals.vwap > 0
      ? ((market.price - signals.vwap) / signals.vwap) * 100
      : null;

  return {
    symbol: market.symbol,
    action,
    strength,
    score: totalScore,
    reasons,
    targetAllocationPct: targetAllocation,
    confidence,
    session: sessionName,
    gapPct: signals.gapPct,
    stochRsi: signals.stochRsi,
    atrPct: signals.atrPct,
    vwapDev,
    orbBreakoutPct: signals.orb?.breakoutPct ?? null,
    regime,
  };
}

export function activeSessionFromPolicy(policy: SessionPolicy): SessionName {
  return getSessionClock(policy).active;
}
