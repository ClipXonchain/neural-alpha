import type { PortfolioSnapshot, PortfolioPosition, TradeResult } from "../utils/types.js";
import { logger } from "../utils/logger.js";

export class PortfolioTracker {
  private initialValueUsd: number;
  private cashUsd: number;
  private positions: Map<string, { amount: number; avgEntryPrice: number }> = new Map();
  private peakPnlPct: Map<string, number> = new Map();
  private tradeHistory: TradeResult[] = [];
  private snapshots: PortfolioSnapshot[] = [];
  private peakValueUsd: number;
  private dailyTradesByDate: Map<string, number> = new Map();

  constructor(initialCashUsd: number) {
    this.initialValueUsd = initialCashUsd;
    this.cashUsd = initialCashUsd;
    this.peakValueUsd = initialCashUsd;
  }

  get cash(): number {
    return this.cashUsd;
  }

  /** Sync available USDT from on-chain wallet (live mode). */
  setCashUsd(amount: number) {
    this.cashUsd = Math.max(0, amount);
  }

  get initialValue(): number {
    return this.initialValueUsd;
  }

  get tradeCount(): number {
    return this.tradeHistory.length;
  }

  getPosition(symbol: string): { amount: number; avgEntryPrice: number } | undefined {
    return this.positions.get(symbol);
  }

  getAllPositions(): Map<string, { amount: number; avgEntryPrice: number }> {
    return new Map(this.positions);
  }

  getTodayTradeCount(): number {
    const today = new Date().toISOString().split("T")[0];
    return this.dailyTradesByDate.get(today) || 0;
  }

  recordBuy(symbol: string, amountUsd: number, tokenAmount: number, price: number) {
    if (amountUsd > this.cashUsd) {
      logger.warn("Buy exceeds cash", { symbol, amountUsd, cash: this.cashUsd });
      return;
    }

    this.cashUsd -= amountUsd;

    const existing = this.positions.get(symbol);
    if (existing) {
      const totalCost = existing.avgEntryPrice * existing.amount + price * tokenAmount;
      const totalAmount = existing.amount + tokenAmount;
      existing.avgEntryPrice = totalCost / totalAmount;
      existing.amount = totalAmount;
    } else {
      this.positions.set(symbol, { amount: tokenAmount, avgEntryPrice: price });
    }

    this.incrementDailyTrades();
    logger.trade("Portfolio buy recorded", {
      symbol, amountUsd, tokenAmount, price, cashRemaining: this.cashUsd,
    });
  }

  recordSell(symbol: string, tokenAmount: number, receivedUsd: number, price: number) {
    const existing = this.positions.get(symbol);
    if (!existing) {
      logger.warn("Sell for non-existent position", { symbol });
      return;
    }

    existing.amount -= tokenAmount;
    if (existing.amount <= 0.000001) {
      this.positions.delete(symbol);
      this.peakPnlPct.delete(symbol);
    }

    this.cashUsd += receivedUsd;
    this.incrementDailyTrades();

    const pnl = (price - existing.avgEntryPrice) * tokenAmount;
    logger.trade("Portfolio sell recorded", {
      symbol, tokenAmount, receivedUsd, price, pnl, cashRemaining: this.cashUsd,
    });
  }

  recordTrade(result: TradeResult) {
    this.tradeHistory.push(result);
  }

  private incrementDailyTrades() {
    const today = new Date().toISOString().split("T")[0];
    this.dailyTradesByDate.set(today, (this.dailyTradesByDate.get(today) || 0) + 1);
  }

  snapshot(currentPrices: Map<string, number>): PortfolioSnapshot {
    const positionSnapshots: PortfolioPosition[] = [];
    let positionsValueUsd = 0;

    for (const [symbol, pos] of this.positions) {
      const currentPrice = currentPrices.get(symbol) || pos.avgEntryPrice;
      const valueUsd = pos.amount * currentPrice;
      positionsValueUsd += valueUsd;

      positionSnapshots.push({
        symbol,
        amount: pos.amount,
        avgEntryPrice: pos.avgEntryPrice,
        currentPrice,
        unrealizedPnl: (currentPrice - pos.avgEntryPrice) * pos.amount,
        unrealizedPnlPct: ((currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100,
        weight: 0,
      });
    }

    const totalValueUsd = this.cashUsd + positionsValueUsd;

    for (const p of positionSnapshots) {
      p.weight = totalValueUsd > 0 ? ((p.amount * p.currentPrice) / totalValueUsd) * 100 : 0;
    }

    if (totalValueUsd > this.peakValueUsd) {
      this.peakValueUsd = totalValueUsd;
    }

    const drawdownPct =
      this.peakValueUsd > 0
        ? ((this.peakValueUsd - totalValueUsd) / this.peakValueUsd) * 100
        : 0;

    const snap: PortfolioSnapshot = {
      timestamp: Date.now(),
      totalValueUsd,
      cashUsd: this.cashUsd,
      positions: positionSnapshots,
      dailyPnl: 0,
      totalPnl: totalValueUsd - this.initialValueUsd,
      totalPnlPct: ((totalValueUsd - this.initialValueUsd) / this.initialValueUsd) * 100,
      maxDrawdownPct: drawdownPct,
      tradeCount: this.tradeHistory.length,
    };

    if (this.snapshots.length > 0) {
      const lastSnap = this.snapshots[this.snapshots.length - 1];
      snap.dailyPnl = totalValueUsd - lastSnap.totalValueUsd;
    }

    this.snapshots.push(snap);
    return snap;
  }

  getMaxDrawdown(): number {
    const totalValue = this.cashUsd +
      Array.from(this.positions.values()).reduce((s, p) => s + p.amount * p.avgEntryPrice, 0);
    if (this.peakValueUsd <= 0) return 0;
    return ((this.peakValueUsd - totalValue) / this.peakValueUsd) * 100;
  }

  getTradeHistory(): TradeResult[] {
    return [...this.tradeHistory];
  }

  getSnapshots(): PortfolioSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * Trailing stop: if position peaked at +5% or more and falls back to +1.5% or below, sell.
   */
  getTrailingStopSells(currentPrices: Map<string, number>): string[] {
    const TRAIL_ACTIVATE_PCT = 5;
    const TRAIL_FLOOR_PCT = 1.5;
    const toSell: string[] = [];

    for (const [symbol, pos] of this.positions) {
      const currentPrice = currentPrices.get(symbol) || pos.avgEntryPrice;
      const pnlPct = ((currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100;
      const prevPeak = this.peakPnlPct.get(symbol) ?? pnlPct;
      const peak = Math.max(prevPeak, pnlPct);
      this.peakPnlPct.set(symbol, peak);

      if (peak >= TRAIL_ACTIVATE_PCT && pnlPct <= TRAIL_FLOOR_PCT) {
        toSell.push(symbol);
      }
    }

    return toSell;
  }

  getPeakPnlPct(symbol: string): number | undefined {
    return this.peakPnlPct.get(symbol);
  }
}
