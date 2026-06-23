import type { PortfolioSnapshot, PortfolioPosition, TradeResult, RiskExit } from "../utils/types.js";
import { MIN_GAS_RESERVE_USD, MIN_POSITION_VALUE_USD } from "../config.js";
import { logger } from "../utils/logger.js";

export class PortfolioTracker {
  private initialValueUsd: number;
  private cashUsd: number;
  private positions: Map<string, { amount: number; avgEntryPrice: number }> = new Map();
  private peakPnlPct: Map<string, number> = new Map();
  private tradeHistory: TradeResult[] = [];
  /** DB / chain / confirmed trades — never purged from Recent Trades display. */
  private persistentTradeIds = new Set<string>();
  private snapshots: PortfolioSnapshot[] = [];
  private peakValueUsd: number;
  private dailyTradesByDate: Map<string, number> = new Map();
  /** Once true, the NAV baseline (initial + peak) reflects real capital. */
  private baselineInitialized: boolean;
  /** Cumulative realized PnL from closed (sold) positions. */
  private realizedPnlUsd = 0;
  /** Native gas coin (BNB on BSC) — counted in NAV but not traded. */
  private gasReserveUsd = 0;
  private gasReserveAmount = 0;
  private gasReserveSymbol = "BNB";
  /** Opening NAV for the current calendar day (UTC) — daily PnL baseline. */
  private dayStartValueUsd = 0;
  private currentDay = "";

  constructor(initialCashUsd: number, deferBaseline = false) {
    this.initialValueUsd = initialCashUsd;
    this.cashUsd = initialCashUsd;
    this.peakValueUsd = initialCashUsd;
    // Live mode defers the baseline until the real on-chain NAV is known,
    // so a placeholder config value can't cause a false 100% drawdown.
    this.baselineInitialized = !deferBaseline;
  }

  get cash(): number {
    return this.cashUsd;
  }

  /** BNB above the minimum gas reserve (gas only — not used for buys). */
  getSpendableBnbUsd(): number {
    return Math.max(0, this.gasReserveUsd - MIN_GAS_RESERVE_USD);
  }

  /** Total USD available to fund new buys (USDT only). */
  getSpendableCash(): number {
    return this.cashUsd;
  }

  /** Sync available USDT from on-chain wallet (live mode). */
  setCashUsd(amount: number) {
    this.cashUsd = Math.max(0, amount);
  }

  get initialValue(): number {
    return this.initialValueUsd;
  }

  get realizedPnl(): number {
    return this.realizedPnlUsd;
  }

  get hasBaseline(): boolean {
    return this.baselineInitialized;
  }

  getPeakNav(): number {
    return this.peakValueUsd;
  }

  /** Restore peak / baseline from Neon after agent restart. */
  restorePersistedNav(state: {
    peakNavUsd: number;
    initialNavUsd: number;
    baselineInitialized: boolean;
  }) {
    if (!state.baselineInitialized || state.peakNavUsd <= 0) return;
    if (!this.baselineInitialized) {
      this.initialValueUsd = state.initialNavUsd;
      this.peakValueUsd = state.peakNavUsd;
      this.baselineInitialized = true;
      logger.info("Portfolio NAV restored from database", {
        peakNavUsd: Math.round(state.peakNavUsd * 100) / 100,
        initialNavUsd: Math.round(state.initialNavUsd * 100) / 100,
      });
    } else {
      this.peakValueUsd = Math.max(this.peakValueUsd, state.peakNavUsd);
    }
  }

  /** Merge confirmed trades loaded from Neon or on-chain backfill (survives restarts). */
  hydrateTradeHistory(trades: import("../utils/types.js").TradeResult[]) {
    if (trades.length === 0) return;
    const existing = new Set(this.tradeHistory.map((t) => t.orderId));
    for (const t of trades) {
      if (!existing.has(t.orderId)) this.tradeHistory.push(t);
      this.persistentTradeIds.add(t.orderId);
    }
    this.tradeHistory.sort((a, b) => a.timestamp - b.timestamp);
    this.rebuildDailyTradeCounts();
    logger.info("Trade history hydrated from database", { count: trades.length });
  }

  /** Mark a trade as persisted/confirmed so it stays in Recent Trades after reconcile. */
  markTradePersisted(orderId: string) {
    this.persistentTradeIds.add(orderId);
  }

  get gasReserve(): { symbol: string; amount: number; valueUsd: number } {
    return {
      symbol: this.gasReserveSymbol,
      amount: this.gasReserveAmount,
      valueUsd: this.gasReserveUsd,
    };
  }

  /** Native gas balance (BNB) — included in NAV, excluded from tradeable cash. */
  setGasReserve(symbol: string, amount: number, valueUsd: number) {
    this.gasReserveSymbol = symbol;
    this.gasReserveAmount = Math.max(0, amount);
    this.gasReserveUsd = Math.max(0, valueUsd);
  }

  /**
   * Anchor the NAV baseline (initial value + peak) to the real portfolio
   * value. Call once in live mode after the first on-chain wallet sync.
   * No-op if NAV is non-positive (avoids locking in a bad baseline) or if
   * already initialized.
   */
  setBaselineNav(navUsd: number) {
    if (this.baselineInitialized) return;
    if (!Number.isFinite(navUsd) || navUsd <= 0) return;
    this.initialValueUsd = navUsd;
    this.peakValueUsd = navUsd;
    this.baselineInitialized = true;
    logger.info("Portfolio NAV baseline anchored", { navUsd: Math.round(navUsd * 100) / 100 });
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

  clearPositions() {
    this.positions.clear();
    this.peakPnlPct.clear();
  }

  /**
   * Make on-chain holdings the source of truth for positions (live mode).
   * - Drops tracked positions no longer held on-chain.
   * - Updates amounts for positions still held (keeping known avg entry price).
   * - Adds newly discovered holdings, using current price as their cost basis
   *   (we don't know the original entry, so unrealized PnL starts at ~0).
   */
  reconcileOnChainPositions(
    holdings: Map<string, number>,
    prices: Map<string, number>
  ): { added: string[]; removed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];

    for (const symbol of [...this.positions.keys()]) {
      if (!holdings.has(symbol)) {
        this.positions.delete(symbol);
        this.peakPnlPct.delete(symbol);
        removed.push(symbol);
      }
    }

    for (const [symbol, amount] of holdings) {
      if (amount <= 0) continue;
      const existing = this.positions.get(symbol);
      if (existing) {
        existing.amount = amount;
      } else {
        const price = prices.get(symbol) ?? 0;
        if (price > 0) {
          this.positions.set(symbol, { amount, avgEntryPrice: price });
          added.push(symbol);
        }
      }
    }

    return { added, removed };
  }

  /** Drop trades without a confirmed tx hash and rebuild daily counters. */
  purgeUnconfirmedTrades(isConfirmed: (txHash: string | undefined) => boolean) {
    const kept = this.tradeHistory.filter((t) => isConfirmed(t.txHash));
    if (kept.length === this.tradeHistory.length) return 0;

    const removed = this.tradeHistory.length - kept.length;
    this.tradeHistory = kept;
    this.rebuildDailyTradeCounts();
    return removed;
  }

  /**
   * Remove "successful" buys that aren't backed by on-chain holdings.
   * These appear when TWAK reports a hash but the swap never settled.
   */
  purgeTradesNotBackedByChain(heldSymbols: Set<string>, baseCurrency: string): number {
    const stables = new Set([baseCurrency.toUpperCase(), "USDT", "USD", "BNB"]);
    const before = this.tradeHistory.length;
    this.tradeHistory = this.tradeHistory.filter((t) => {
      if (this.persistentTradeIds.has(t.orderId)) return true;
      if (!t.success) return true;
      const from = t.fromToken.toUpperCase();
      if (!stables.has(from)) return true;
      return heldSymbols.has(t.toToken.toUpperCase());
    });
    const purged = before - this.tradeHistory.length;
    if (purged > 0) this.rebuildDailyTradeCounts();
    return purged;
  }

  /** Best-effort NAV for drawdown recalibration (uses entry prices when live quotes missing). */
  estimateNavUsd(prices?: Map<string, number>): number {
    let positionsValue = 0;
    for (const [symbol, pos] of this.positions) {
      const price = prices?.get(symbol) ?? pos.avgEntryPrice;
      positionsValue += pos.amount * price;
    }
    return this.cashUsd + this.gasReserveUsd + positionsValue;
  }

  /** Reset inflated peak after phantom in-memory trades are purged. */
  recalibratePeakAfterPhantomPurge(navUsd: number, purgedCount: number) {
    if (!this.baselineInitialized || purgedCount <= 0) return;
    const oldPeak = this.peakValueUsd;
    this.peakValueUsd = Math.max(navUsd, this.initialValueUsd);
    logger.info("Peak NAV recalibrated after phantom trade purge", {
      oldPeak: Math.round(oldPeak * 100) / 100,
      newPeak: Math.round(this.peakValueUsd * 100) / 100,
      navUsd: Math.round(navUsd * 100) / 100,
      purged: purgedCount,
    });
  }

  /**
   * After a full on-chain sync, clamp peak to actual NAV when it was inflated
   * by positions that were dropped due to incomplete balance discovery.
   */
  recalibratePeakToOnChainNav(navUsd: number, rediscovered: number) {
    if (!this.baselineInitialized || navUsd <= 0 || rediscovered <= 0) return;
    if (this.peakValueUsd <= navUsd * 1.005) return;

    const oldPeak = this.peakValueUsd;
    this.peakValueUsd = Math.max(navUsd, this.initialValueUsd);
    logger.info("Peak NAV recalibrated after on-chain holdings rediscovered", {
      oldPeak: Math.round(oldPeak * 100) / 100,
      newPeak: Math.round(this.peakValueUsd * 100) / 100,
      navUsd: Math.round(navUsd * 100) / 100,
      rediscovered,
    });
  }

  private rebuildDailyTradeCounts() {
    this.dailyTradesByDate.clear();
    for (const t of this.tradeHistory) {
      const day = new Date(t.timestamp).toISOString().split("T")[0];
      this.dailyTradesByDate.set(day, (this.dailyTradesByDate.get(day) || 0) + 1);
    }
  }

  recordBuy(
    symbol: string,
    amountUsd: number,
    tokenAmount: number,
    price: number,
    fundingCurrency = "USDT"
  ) {
    const funding = fundingCurrency.toUpperCase();

    if (funding !== "USDT") {
      logger.warn("Buy rejected — only USDT funding allowed", { symbol, funding });
      return;
    }
    if (amountUsd > this.cashUsd) {
      logger.warn("Buy exceeds USDT cash", { symbol, amountUsd, cash: this.cashUsd });
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
      symbol, amountUsd, tokenAmount, price, funding: funding,
      cashRemaining: this.cashUsd, bnbRemainingUsd: this.gasReserveUsd,
    });
  }

  /** Returns the realized PnL (USD) booked on this sell. */
  recordSell(symbol: string, tokenAmount: number, receivedUsd: number, price: number): number {
    const existing = this.positions.get(symbol);
    if (!existing) {
      logger.warn("Sell for non-existent position", { symbol });
      return 0;
    }

    const entryPrice = existing.avgEntryPrice;
    // Realized PnL = proceeds minus cost basis of the tokens sold.
    const costBasis = entryPrice * tokenAmount;
    const pnl = receivedUsd - costBasis;

    existing.amount -= tokenAmount;
    if (existing.amount <= 0.000001) {
      this.positions.delete(symbol);
      this.peakPnlPct.delete(symbol);
    }

    this.cashUsd += receivedUsd;
    this.realizedPnlUsd += pnl;
    this.incrementDailyTrades();

    logger.trade("Portfolio sell recorded", {
      symbol, tokenAmount, receivedUsd, price, pnl: Math.round(pnl * 100) / 100,
      realizedPnlTotal: Math.round(this.realizedPnlUsd * 100) / 100,
      cashRemaining: this.cashUsd,
    });
    return pnl;
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
      if (valueUsd < MIN_POSITION_VALUE_USD) continue;
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

    const totalValueUsd = this.cashUsd + this.gasReserveUsd + positionsValueUsd;

    for (const p of positionSnapshots) {
      p.weight = totalValueUsd > 0 ? ((p.amount * p.currentPrice) / totalValueUsd) * 100 : 0;
    }

    // Only track peak / drawdown once the baseline reflects real capital.
    if (this.baselineInitialized && totalValueUsd > this.peakValueUsd) {
      this.peakValueUsd = totalValueUsd;
    }

    const drawdownPct = this.computeDrawdown(totalValueUsd);

    const snap: PortfolioSnapshot = {
      timestamp: Date.now(),
      totalValueUsd,
      cashUsd: this.cashUsd,
      positions: positionSnapshots,
      dailyPnl: 0,
      totalPnl: totalValueUsd - this.initialValueUsd,
      totalPnlPct: this.initialValueUsd > 0
        ? ((totalValueUsd - this.initialValueUsd) / this.initialValueUsd) * 100
        : 0,
      realizedPnl: this.realizedPnlUsd,
      gasReserveUsd: this.gasReserveUsd,
      maxDrawdownPct: drawdownPct,
      tradeCount: this.tradeHistory.length,
    };

    // Daily PnL = NAV now − NAV at the first snapshot of the current UTC day.
    const today = new Date().toISOString().slice(0, 10);
    if (this.currentDay !== today || this.dayStartValueUsd === 0) {
      this.currentDay = today;
      this.dayStartValueUsd = totalValueUsd;
    }
    snap.dailyPnl = totalValueUsd - this.dayStartValueUsd;

    this.snapshots.push(snap);
    return snap;
  }

  getMaxDrawdown(): number {
    const totalValue = this.cashUsd + this.gasReserveUsd +
      Array.from(this.positions.values()).reduce((s, p) => s + p.amount * p.avgEntryPrice, 0);
    return this.computeDrawdown(totalValue);
  }

  /**
   * Drawdown from peak NAV, clamped to [0, 100]. Returns 0 until the baseline
   * is anchored to real capital, so a placeholder/empty NAV can't read as a
   * false 100% drawdown.
   */
  private computeDrawdown(totalValueUsd: number): number {
    if (!this.baselineInitialized) return 0;
    if (this.peakValueUsd <= 0) return 0;
    const dd = ((this.peakValueUsd - totalValueUsd) / this.peakValueUsd) * 100;
    return Math.min(100, Math.max(0, dd));
  }

  getTradeHistory(): TradeResult[] {
    return [...this.tradeHistory];
  }

  getSnapshots(): PortfolioSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * Unified, safety-first exit engine. Evaluates every open position against
   * three protective rules and returns the exits that should fire this cycle:
   *
   *   1. Hard stop-loss   — cut losers early so no single trade craters NAV.
   *   2. Take-profit      — bank strong gains before they mean-revert.
   *   3. Trailing stop    — once in solid profit, exit if price gives back
   *                         a set amount from its peak (locks momentum gains).
   *
   * Cutting losers fast + trailing winners is the core mechanism that keeps
   * drawdown low while still capturing upside.
   */
  getRiskManagedExits(
    currentPrices: Map<string, number>,
    params: {
      stopLossPct: number;
      takeProfitPct: number;
      trailingActivatePct: number;
      trailingGivebackPct: number;
    }
  ): RiskExit[] {
    const exits: RiskExit[] = [];

    for (const [symbol, pos] of this.positions) {
      const currentPrice = currentPrices.get(symbol) || pos.avgEntryPrice;
      const pnlPct = ((currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100;

      const prevPeak = this.peakPnlPct.get(symbol) ?? pnlPct;
      const peak = Math.max(prevPeak, pnlPct);
      this.peakPnlPct.set(symbol, peak);

      // 1. Hard stop-loss — highest priority, protects against deep losses.
      if (pnlPct <= -Math.abs(params.stopLossPct)) {
        exits.push({
          symbol,
          kind: "stop_loss",
          pnlPct,
          reason: `Stop-loss hit: ${pnlPct.toFixed(1)}% ≤ -${params.stopLossPct}%`,
        });
        continue;
      }

      // 2. Take-profit — bank outsized gains.
      if (pnlPct >= params.takeProfitPct) {
        exits.push({
          symbol,
          kind: "take_profit",
          pnlPct,
          reason: `Take-profit hit: +${pnlPct.toFixed(1)}% ≥ +${params.takeProfitPct}%`,
        });
        continue;
      }

      // 3. Trailing stop — only once the position has been meaningfully green.
      if (
        peak >= params.trailingActivatePct &&
        peak - pnlPct >= params.trailingGivebackPct
      ) {
        exits.push({
          symbol,
          kind: "trailing_stop",
          pnlPct,
          reason: `Trailing stop: gave back ${(peak - pnlPct).toFixed(1)}pts from peak +${peak.toFixed(1)}%`,
        });
      }
    }

    return exits;
  }

  getPeakPnlPct(symbol: string): number | undefined {
    return this.peakPnlPct.get(symbol);
  }
}
