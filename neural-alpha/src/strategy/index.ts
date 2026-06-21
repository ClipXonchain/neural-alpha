import type { MarketData, TradeSignal, AgentConfig } from "../utils/types.js";
import { computeSignals, generateSignal } from "./signals.js";
import type { NewsSentiment } from "./news-sentiment.js";
import { isStablecoin } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Strategy orchestrator — runs all market data through the signal
 * pipeline and returns ranked trade signals for the decision engine.
 */
export function analyzeMarkets(
  markets: MarketData[],
  fearGreedIndex: number | null,
  config: AgentConfig,
  newsSentiment?: Map<string, NewsSentiment>
): TradeSignal[] {
  const signals: TradeSignal[] = [];

  for (const market of markets) {
    if (isStablecoin(market.symbol)) continue;

    const technicals = computeSignals(market.symbol);
    const news = newsSentiment?.get(market.symbol) ?? null;
    const signal = generateSignal(market, technicals, fearGreedIndex, news);
    signals.push(signal);
  }

  // Sort by absolute score — strongest signals first
  signals.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

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
 */
export function selectTrades(
  signals: TradeSignal[],
  config: AgentConfig,
  existingPositions: Set<string>
): TradeSignal[] {
  const selected: TradeSignal[] = [];

  // Priority 1: sells for existing positions with sell signals
  const sells = signals.filter(
    (s) => s.action === "sell" && existingPositions.has(s.symbol)
  );
  selected.push(...sells);

  // Priority 2: buys — strongest signals first, up to available slots
  const buys = signals.filter((s) => s.action === "buy");
  const availableSlots = config.maxPortfolioTokens - existingPositions.size + sells.length;

  for (const buy of buys) {
    if (selected.filter((s) => s.action === "buy").length >= availableSlots) break;
    if (selected.filter((s) => s.action === "buy").length >= 2) break; // Max 2 buys per cycle
    selected.push(buy);
  }

  return selected;
}
