import type { AgentConfig, RiskCheck, TradeSignal, PortfolioSnapshot } from "../utils/types.js";
import { isEligibleToken, isStablecoin } from "../config.js";
import { PortfolioTracker } from "./portfolio.js";
import { logger } from "../utils/logger.js";
import { getTokenMomentumMetrics } from "../strategy/signals.js";

export class RiskManager {
  private config: AgentConfig;
  private portfolio: PortfolioTracker;

  constructor(config: AgentConfig, portfolio: PortfolioTracker) {
    this.config = config;
    this.portfolio = portfolio;
  }

  /**
   * Full pre-trade risk validation. Returns a RiskCheck with pass/fail
   * and a list of any violations. The agent MUST NOT execute a trade
   * if passed === false.
   */
  validateTrade(signal: TradeSignal, tradeAmountUsd: number): RiskCheck {
    const violations: string[] = [];
    const dailyTradeCount = this.portfolio.getTodayTradeCount();
    const drawdownPct = this.portfolio.getMaxDrawdown();
    const positionSizePct = this.portfolio.cash > 0
      ? (tradeAmountUsd / this.portfolio.cash) * 100
      : 100;

    // 1. Eligible token check (hard requirement)
    if (!isEligibleToken(signal.symbol)) {
      violations.push(`Token ${signal.symbol} is NOT on the eligible BEP-20 list`);
    }

    // 2. Stablecoin guard — don't trade stables for stables
    if (isStablecoin(signal.symbol) && signal.action === "buy") {
      violations.push(`Cannot buy stablecoin ${signal.symbol} as a position`);
    }

    // 3. Max drawdown gate (competition disqualifier at 30%)
    if (drawdownPct >= this.config.maxDrawdownPct) {
      violations.push(
        `Drawdown ${drawdownPct.toFixed(1)}% exceeds max ${this.config.maxDrawdownPct}% — HALT TRADING`
      );
    }

    // 4. Safety buffer: stop new buys at 80% of max drawdown
    if (signal.action === "buy" && drawdownPct >= this.config.maxDrawdownPct * 0.8) {
      violations.push(
        `Drawdown ${drawdownPct.toFixed(1)}% approaching limit — no new buys allowed`
      );
    }

    // 5. Daily trade limit
    if (dailyTradeCount >= this.config.maxDailyTrades) {
      violations.push(
        `Daily trade limit reached: ${dailyTradeCount}/${this.config.maxDailyTrades}`
      );
    }

    // 6. Position size limit
    if (tradeAmountUsd > this.config.maxPositionSizeUsd) {
      violations.push(
        `Trade $${tradeAmountUsd.toFixed(2)} exceeds max position size $${this.config.maxPositionSizeUsd}`
      );
    }

    // 7. Minimum trade amount
    if (tradeAmountUsd < this.config.minTradeAmountUsd) {
      violations.push(
        `Trade $${tradeAmountUsd.toFixed(2)} below minimum $${this.config.minTradeAmountUsd}`
      );
    }

    // 8. Cash availability
    if (signal.action === "buy" && tradeAmountUsd > this.portfolio.cash) {
      violations.push(
        `Insufficient cash: need $${tradeAmountUsd.toFixed(2)}, have $${this.portfolio.cash.toFixed(2)}`
      );
    }

    // 9. Max portfolio tokens
    const currentPositionCount = this.portfolio.getAllPositions().size;
    if (
      signal.action === "buy" &&
      !this.portfolio.getPosition(signal.symbol) &&
      currentPositionCount >= this.config.maxPortfolioTokens
    ) {
      violations.push(
        `Max ${this.config.maxPortfolioTokens} positions reached (have ${currentPositionCount})`
      );
    }

    // 10. Signal confidence threshold
    if (signal.confidence < 0.4) {
      violations.push(`Signal confidence ${(signal.confidence * 100).toFixed(0)}% below 40% threshold`);
    }

    const passed = violations.length === 0;

    if (!passed) {
      logger.risk("Trade blocked by risk manager", {
        symbol: signal.symbol,
        action: signal.action,
        violations,
        drawdownPct: Math.round(drawdownPct * 10) / 10,
        dailyTradeCount,
      });
    }

    return {
      passed,
      violations,
      drawdownPct,
      dailyTradeCount,
      positionSizePct,
    };
  }

  /**
   * Compute the safe trade size for a buy signal, respecting all limits.
   */
  computeTradeSize(signal: TradeSignal): number {
    // Sells: full position value (USD estimate at entry — executor uses full token amount)
    if (signal.action === "sell") {
      const pos = this.portfolio.getPosition(signal.symbol);
      if (!pos) return 0;
      return Math.max(0, Math.round(pos.amount * pos.avgEntryPrice * 100) / 100);
    }

    const maxByConfig = this.config.maxPositionSizeUsd;
    const maxByCash = this.portfolio.cash * 0.9; // Keep 10% reserve
    const maxByAllocation = (this.portfolio.cash + this.estimatePositionsValue()) *
      (signal.targetAllocationPct / 100);

    let size = Math.min(maxByConfig, maxByCash, maxByAllocation);

    // Scale by signal strength
    const strengthMultiplier = {
      strong_buy: 1.0,
      buy: 0.6,
      neutral: 0,
      sell: 0,
      strong_sell: 0,
    }[signal.strength];

    size *= strengthMultiplier;

    // Scale by confidence
    size *= signal.confidence;

    // Volatility-weighted sizing: high ATR → slightly smaller positions
    if (signal.action === "buy") {
      const { atrPct } = getTokenMomentumMetrics(signal.symbol);
      const baselineAtr = 2; // ~2% daily ATR baseline for mid-cap momentum
      const volMultiplier = Math.min(
        1.2,
        Math.max(0.55, baselineAtr / Math.max(atrPct ?? baselineAtr, 0.5))
      );
      size *= volMultiplier;
    }

    return Math.max(0, Math.round(size * 100) / 100);
  }

  /**
   * Check if the agent is in emergency mode (high drawdown).
   * In emergency mode, only sells are allowed.
   */
  isEmergencyMode(): boolean {
    const drawdown = this.portfolio.getMaxDrawdown();
    return drawdown >= this.config.maxDrawdownPct * 0.8;
  }

  /**
   * Generate a risk summary for logging/display.
   */
  riskSummary(): Record<string, unknown> {
    return {
      drawdownPct: Math.round(this.portfolio.getMaxDrawdown() * 10) / 10,
      maxDrawdownLimit: this.config.maxDrawdownPct,
      dailyTrades: this.portfolio.getTodayTradeCount(),
      maxDailyTrades: this.config.maxDailyTrades,
      cashUsd: Math.round(this.portfolio.cash * 100) / 100,
      positionCount: this.portfolio.getAllPositions().size,
      maxPositions: this.config.maxPortfolioTokens,
      emergencyMode: this.isEmergencyMode(),
    };
  }

  private estimatePositionsValue(): number {
    let total = 0;
    for (const pos of this.portfolio.getAllPositions().values()) {
      total += pos.amount * pos.avgEntryPrice;
    }
    return total;
  }
}
