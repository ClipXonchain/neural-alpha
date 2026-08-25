import type { MarketData, TradeSignal, AgentConfig } from "../utils/types.js";
import { computeIndexRegime, computeSignals, generateSignal } from "./signals.js";
import type { NewsSentiment } from "./news-sentiment.js";
import { blendEquityAndCmc, type CmcMacroSnapshot } from "./cmc-macro.js";
import { isStablecoin, isTradableToken } from "../config.js";
import { logger } from "../utils/logger.js";
import { getSessionClock } from "./session.js";
import { getSessionProfile } from "./presets.js";

/**
 * Strategy orchestrator — runs all market data through the session-aware
 * signal pipeline and returns ranked trade signals for the decision engine.
 */
export function analyzeMarkets(
  markets: MarketData[],
  config: AgentConfig,
  newsSentiment?: Map<string, NewsSentiment>,
  cmcMacro?: CmcMacroSnapshot | null
): TradeSignal[] {
  const signals: TradeSignal[] = [];
  const clock = getSessionClock(config.sessionPolicy);
  const profile = getSessionProfile(clock.active);
  const equity = computeIndexRegime(markets);
  const regime = blendEquityAndCmc(equity, cmcMacro);

  for (const market of markets) {
    if (isStablecoin(market.symbol)) continue;
    if (!isTradableToken(market.symbol, market.price)) continue;

    const technicals = computeSignals(market.symbol, market.price);
    const news = newsSentiment?.get(market.symbol) ?? null;
    const signal = generateSignal(market, technicals, news, profile, regime, cmcMacro);
    signals.push(signal);
  }

  signals.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  const actionable = signals.filter((s) => s.action !== "hold");
  if (actionable.length > 0) {
    logger.info("Strategy analysis complete", {
      session: clock.active,
      policy: clock.policy,
      regime,
      cmc: cmcMacro
        ? {
            tape: cmcMacro.regime,
            mcap24hPct: cmcMacro.mcap24hPct,
            sizeScale: cmcMacro.sizeScale,
            eventRisk: cmcMacro.eventRisk,
          }
        : null,
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
 * Select the best trades this cycle.
 *
 * One new buy at a time — pick the strongest unused name, then wait
 * (minBuyIntervalMs) before the next entry. Protective SL/TP sells are
 * injected by the agent. Signal-driven exits require strong_sell.
 */
export function selectTrades(
  signals: TradeSignal[],
  config: AgentConfig,
  existingPositions: Set<string>
): TradeSignal[] {
  const selected: TradeSignal[] = [];
  const session = getSessionClock(config.sessionPolicy).active;

  const sells = signals.filter(
    (s) =>
      s.action === "sell" &&
      s.strength === "strong_sell" &&
      existingPositions.has(s.symbol)
  );
  selected.push(...sells);

  let buys = signals.filter((s) => s.action === "buy");
  if (session === "close") {
    buys = [...buys].sort((a, b) => {
      const aV = a.vwapDev ?? -99;
      const bV = b.vwapDev ?? -99;
      if (aV > 0 !== bV > 0) return aV > 0 ? -1 : 1;
      return Math.abs(b.score) - Math.abs(a.score);
    });
  } else if (session === "overnight") {
    buys = [...buys].sort((a, b) => {
      const aGap = a.gapPct ?? 0;
      const bGap = b.gapPct ?? 0;
      return aGap - bGap;
    });
  }

  const openAfterSells = existingPositions.size - sells.length;
  const availableSlots = Math.max(0, config.maxPortfolioTokens - openAfterSells);
  if (availableSlots <= 0) return selected;

  const fresh = buys.filter((b) => !existingPositions.has(b.symbol));
  const strong = fresh.filter((b) => b.strength === "strong_buy");
  const pick = (strong.length > 0 ? strong : fresh)[0];
  if (pick) selected.push(pick);

  return selected;
}
