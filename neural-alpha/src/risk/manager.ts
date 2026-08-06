import type { AgentConfig, RiskCheck, TradeSignal, PortfolioSnapshot } from "../utils/types.js";
import { isEligibleToken, isStablecoin, isTradableToken, MIN_POSITION_VALUE_USD } from "../config.js";
import { hasBscSwapAddress } from "../integrations/bsc-token-addresses.js";
import { isUserBlacklisted } from "./token-blacklist.js";
import { getLatestPrice } from "../data/market.js";
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

  getPortfolio(): PortfolioTracker {
    return this.portfolio;
  }

  /**
   * Full pre-trade risk validation. Returns a RiskCheck with pass/fail
   * and a list of any violations. The agent MUST NOT execute a trade
   * if passed === false.
   */
  validateTrade(
    signal: TradeSignal,
    tradeAmountUsd: number,
    opts: { manual?: boolean; explicitAmount?: boolean } = {}
  ): RiskCheck {
    const violations: string[] = [];
    this.portfolio.purgeDustFromMarket();
    const dailyTradeCount = this.portfolio.getTodayTradeCount();
    const drawdownPct = this.portfolio.getMaxDrawdown();
    const positionSizePct = this.portfolio.getSpendableCash() > 0
      ? (tradeAmountUsd / this.portfolio.getSpendableCash()) * 100
      : 100;

    // 1. Eligible + tradable (not blocklisted / sub-min-price).
    // Manual trades only need a routable BEP-20 contract — not the competition allowlist.
    if (
      !opts.manual &&
      !isEligibleToken(signal.symbol) &&
      !hasBscSwapAddress(signal.symbol)
    ) {
      violations.push(`Token ${signal.symbol} is NOT on the eligible BEP-20 list`);
    }
    if (
      signal.action === "buy" &&
      isUserBlacklisted(signal.symbol)
    ) {
      violations.push(
        `${signal.symbol} is blacklisted — resume from Signal Monitor to allow entries`
      );
    } else if (
      signal.action === "buy" &&
      !opts.manual &&
      !isTradableToken(signal.symbol, getLatestPrice(signal.symbol))
    ) {
      violations.push(`Token ${signal.symbol} is excluded or below min tradable price`);
    }

    // 2. Stablecoin guard — don't trade stables for stables
    if (isStablecoin(signal.symbol) && signal.action === "buy") {
      violations.push(`Cannot buy stablecoin ${signal.symbol} as a position`);
    }

    // 2b. No duplicate entries — autonomous only. Assistant/manual may add to positions.
    if (
      signal.action === "buy" &&
      !opts.manual &&
      this.portfolio.isMaterialPosition(signal.symbol)
    ) {
      violations.push(
        `Already holding ${signal.symbol} — no duplicate buy (dust below $${MIN_POSITION_VALUE_USD} ignored)`
      );
    }

    // 3–4. Drawdown gates — autonomous only (optional when DISABLE_DRAWDOWN_LIMIT=true).
    if (this.config.drawdownLimitEnabled && !opts.manual) {
      if (signal.action === "buy" && drawdownPct >= this.config.maxDrawdownPct) {
        violations.push(
          `Drawdown ${drawdownPct.toFixed(1)}% exceeds max ${this.config.maxDrawdownPct}% — no new buys`
        );
      }

      if (signal.action === "buy" && drawdownPct >= this.config.maxDrawdownPct * 0.8) {
        violations.push(
          `Drawdown ${drawdownPct.toFixed(1)}% approaching limit — no new buys allowed`
        );
      }
    }

    // 5. Daily trade limit — autonomous pacing only. Manual (operator /
    //    natural-language) commands override it: an explicit user trade should
    //    always go through regardless of how many auto-trades ran today.
    if (!opts.manual && dailyTradeCount >= this.config.maxDailyTrades) {
      violations.push(
        `Daily trade limit reached: ${dailyTradeCount}/${this.config.maxDailyTrades}`
      );
    }

    // 6. Position size limit — autonomous only (assistant may size freely up to cash).
    if (
      !opts.manual &&
      !opts.explicitAmount &&
      tradeAmountUsd > this.config.maxPositionSizeUsd
    ) {
      violations.push(
        `Trade $${tradeAmountUsd.toFixed(2)} exceeds max position size $${this.config.maxPositionSizeUsd}`
      );
    }

    // 7. Minimum trade amount (buys only — allow full position exits).
    //    Manual / explicit-amount commands bypass the autonomous floor.
    if (
      signal.action === "buy" &&
      !opts.manual &&
      !opts.explicitAmount &&
      tradeAmountUsd < this.config.minTradeAmountUsd
    ) {
      violations.push(
        `Trade $${tradeAmountUsd.toFixed(2)} below minimum $${this.config.minTradeAmountUsd}`
      );
    }

    // 8. USDT cash availability
    if (signal.action === "buy" && tradeAmountUsd > this.portfolio.cash) {
      violations.push(
        `Insufficient USDT: need $${tradeAmountUsd.toFixed(2)}, have $${this.portfolio.cash.toFixed(2)}`
      );
    }

    // 9. Max portfolio tokens — autonomous only; assistant may open or add freely.
    const needsNewSlot =
      signal.action === "buy" &&
      !this.portfolio.isMaterialPosition(signal.symbol);
    const currentPositionCount = this.portfolio.countMaterialPositions();
    if (
      !opts.manual &&
      needsNewSlot &&
      currentPositionCount >= this.config.maxPortfolioTokens
    ) {
      violations.push(
        `Max ${this.config.maxPortfolioTokens} positions reached (have ${currentPositionCount})`
      );
    }

    // 10. Signal confidence threshold — autonomous only.
    if (
      signal.action === "buy" &&
      !opts.manual &&
      !opts.explicitAmount &&
      signal.confidence < this.config.minBuyConfidence
    ) {
      violations.push(
        `Signal confidence ${(signal.confidence * 100).toFixed(0)}% below ${(this.config.minBuyConfidence * 100).toFixed(0)}% threshold`
      );
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
      const price =
        getLatestPrice(signal.symbol) ?? pos.avgEntryPrice;
      if (price <= 0) return 0;
      return Math.max(0, Math.round(pos.amount * price * 100) / 100);
    }

    const maxByConfig = this.config.maxPositionSizeUsd;
    const maxByCash = this.portfolio.getSpendableCash() * 0.9; // Keep 10% reserve
    const maxByAllocation = (this.portfolio.getSpendableCash() + this.estimatePositionsValue()) *
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

    // Strategy sizing aggressiveness (SafeTrade < Medium < Momentum)
    size *= this.config.positionSizeMultiplier ?? 1;

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

    // Small computed sizes on tiny accounts: use minimum trade if cash allows.
    if (
      signal.action === "buy" &&
      size > 0 &&
      size < this.config.minTradeAmountUsd &&
      this.portfolio.getSpendableCash() >= this.config.minTradeAmountUsd
    ) {
      size = this.config.minTradeAmountUsd;
    }

    return Math.max(0, Math.round(size * 100) / 100);
  }

  /**
   * Check if the agent is in emergency mode (high drawdown).
   * In emergency mode, only sells are allowed.
   */
  isEmergencyMode(): boolean {
    if (!this.config.drawdownLimitEnabled) return false;
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
      spendableCashUsd: Math.round(this.portfolio.getSpendableCash() * 100) / 100,
      spendableBnbUsd: Math.round(this.portfolio.getSpendableBnbUsd() * 100) / 100,
      positionCount: this.portfolio.countMaterialPositions(),
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
