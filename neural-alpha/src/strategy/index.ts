import type { MarketData, TradeSignal, AgentConfig } from "../utils/types.js";
import { computeSignals, generateSignal } from "./signals.js";
import type { TrendingRank } from "./trending-rank.js";
import { isStablecoin, isTradableToken } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Strategy orchestrator — runs all market data through the signal
 * pipeline and returns ranked trade signals for the decision engine.
 */
export function analyzeMarkets(
  markets: MarketData[],
  fearGreedIndex: number | null,
  config: AgentConfig,
  trendingRanks?: Map<string, TrendingRank>
): TradeSignal[] {
  const signals: TradeSignal[] = [];

  for (const market of markets) {
    if (isStablecoin(market.symbol)) continue;
    if (!isTradableToken(market.symbol, market.price, market.marketCap)) continue;

    const technicals = computeSignals(market.symbol);
    const trending = trendingRanks?.get(market.symbol) ?? null;
    const signal = generateSignal(market, technicals, fearGreedIndex, trending, config.strategy);
    signals.push(signal);
  }

  // Sort: strongest blended score first; on near-ties prefer tokens on Binance trending
  signals.sort((a, b) => {
    const scoreDiff = Math.abs(b.score) - Math.abs(a.score);
    if (Math.abs(scoreDiff) >= 2) return scoreDiff;
    const aTrend = a.reasons.some((r) => /Binance trending/i.test(r)) ? 1 : 0;
    const bTrend = b.reasons.some((r) => /Binance trending/i.test(r)) ? 1 : 0;
    if (bTrend !== aTrend) return bTrend - aTrend;
    return scoreDiff;
  });

  const actionable = signals.filter((s) => s.action !== "hold");
  if (actionable.length > 0) {
    logger.info("Strategy analysis complete", {
      total: markets.length,
      actionable: actionable.length,
      buys: actionable.filter((s) => s.action === "buy").length,
      sells: actionable.filter((s) => s.action === "sell").length,
      topSignal: actionable[0]
        ? `${actionable[0].symbol} ${actionable[0].action} (${actionable[0].score.toFixed(0)})`
        : "none",
    });
  }

  return signals;
}

/**
 * Select the best trades to execute this cycle, respecting portfolio limits.
 *
 * Holding policy: positions are HELD, not churned. We never sell an existing
 * position just to free a slot for a new entry. No duplicate buys into tokens
 * already held above the dust threshold (MIN_POSITION_VALUE_USD). Signal-driven
 * exits require a decisive `strong_sell` (clear reversal); mild weakness is held and left to
 * the protective exits (stop-loss / take-profit / trailing) to manage. When all
 * slots are full, new buys are simply skipped — no forced rotation.
 */
export function selectTrades(
  signals: TradeSignal[],
  config: AgentConfig,
  existingPositions: Set<string>
): TradeSignal[] {
  const selected: TradeSignal[] = [];

  // Priority 1: close positions only on a decisive reversal (strong_sell).
  // Protective exits (stop/TP/trailing) are injected separately by the agent.
  const sells = signals.filter(
    (s) =>
      s.action === "sell" &&
      s.strength === "strong_sell" &&
      existingPositions.has(s.symbol)
  );
  selected.push(...sells);

  // Priority 2: buys — only into genuinely free slots. A position leaving via
  // a strong_sell this cycle frees its slot, but we never sell to make room.
  const buys = signals.filter((s) => s.action === "buy");
  const openAfterSells = existingPositions.size - sells.length;
  const availableSlots = Math.max(0, config.maxPortfolioTokens - openAfterSells);

  let buysAdded = 0;
  const maxBuysPerCycle = Math.max(0, config.maxAutonomousTradesPerCycle);
  for (const buy of buys) {
    if (existingPositions.has(buy.symbol)) continue;
    if (buysAdded >= availableSlots) break;
    if (buysAdded >= maxBuysPerCycle) break;
    selected.push(buy);
    buysAdded++;
  }

  return selected;
}
