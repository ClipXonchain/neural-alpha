import type { PortfolioSnapshot, PortfolioPosition, TradeResult, RiskExit } from "../utils/types.js";
import { MIN_GAS_RESERVE_USD, MIN_POSITION_VALUE_USD } from "../config.js";
import { getLatestPrice } from "../data/market.js";
import { logger } from "../utils/logger.js";
import {
  classifyAssetTrade,
  dedupeAndCleanTradeResults,
  preferTradeRecord,
  realSymbolSideKeys,
  symbolSideKey,
  tradeDedupeKey,
} from "../utils/trade-dedupe.js";

/** Cap in-memory NAV history so dashboard SSE cannot grow without bound. */
const MAX_NAV_POINTS = 240;

function parseTradeAmount(raw?: string): number {
  const n = parseFloat(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function utcDayStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function utcDateKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function isSyntheticTradeHash(txHash?: string): boolean {
  return Boolean(txHash?.startsWith("binance-web3-"));
}

export class PortfolioTracker {
  private initialValueUsd: number;
  private cashUsd: number;
  private positions: Map<string, { amount: number; avgEntryPrice: number }> = new Map();
  /** FIFO lots for campaign Realized PnL (qty × lot price). */
  private lots: Map<string, Array<{ qty: number; price: number }>> = new Map();
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
  private minGasReserveUsd = MIN_GAS_RESERVE_USD;
  /** Latest NAV from the most recent snapshot (live prices). */
  private lastNavUsd = 0;
  /** DB peak/initial restored at startup — applied after wallet sync validates NAV. */
  private pendingNavRestore: {
    peakNavUsd: number;
    initialNavUsd: number;
    dayStartNavUsd?: number;
    dayStartUtcDate?: string;
  } | null = null;
  /** Frozen NAV at UTC midnight (yesterday's close) for Daily PnL. */
  private dayStartNavUsd = 0;
  private dayStartUtcDate = "";
  /** Cost basis restored from Neon when trade replay is incomplete. */
  private persistedEntries = new Map<string, { avgEntryPrice: number; peakPnlPct?: number }>();

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
    return Math.max(0, this.gasReserveUsd - this.minGasReserveUsd);
  }

  setMinGasReserveUsd(usd: number) {
    this.minGasReserveUsd = Math.max(0, usd);
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
    dayStartNavUsd?: number;
    dayStartUtcDate?: string;
  }) {
    if (state.dayStartUtcDate === utcDateKey() && (state.dayStartNavUsd ?? 0) > 0) {
      this.dayStartNavUsd = state.dayStartNavUsd!;
      this.dayStartUtcDate = state.dayStartUtcDate;
    }
    if (!state.baselineInitialized || state.peakNavUsd <= 0) return;
    if (!this.baselineInitialized) {
      this.pendingNavRestore = {
        peakNavUsd: state.peakNavUsd,
        initialNavUsd: state.initialNavUsd,
        dayStartNavUsd: state.dayStartNavUsd,
        dayStartUtcDate: state.dayStartUtcDate,
      };
      logger.info("Portfolio NAV restore deferred until wallet sync", {
        peakNavUsd: Math.round(state.peakNavUsd * 100) / 100,
        initialNavUsd: Math.round(state.initialNavUsd * 100) / 100,
      });
      return;
    }
    this.peakValueUsd = Math.max(this.peakValueUsd, state.peakNavUsd);
  }

  hasPendingNavRestore(): boolean {
    return this.pendingNavRestore !== null;
  }

  /**
   * Apply deferred DB peak/initial after on-chain NAV is known.
   * Discards stale DB values when peak or initial diverges sharply from wallet.
   */
  applyPendingNavRestore(navUsd: number) {
    if (!this.pendingNavRestore || !Number.isFinite(navUsd) || navUsd <= 0) return;
    const { peakNavUsd, initialNavUsd, dayStartNavUsd, dayStartUtcDate } = this.pendingNavRestore;
    this.pendingNavRestore = null;
    if (dayStartUtcDate === utcDateKey() && (dayStartNavUsd ?? 0) > 0) {
      this.dayStartNavUsd = dayStartNavUsd!;
      this.dayStartUtcDate = dayStartUtcDate;
    }

    const peakRatio = peakNavUsd / navUsd;
    const initialRatio = initialNavUsd / navUsd;
    const stale =
      peakRatio > 1.25 ||
      peakRatio < 0.5 ||
      initialRatio > 3 ||
      initialRatio < 0.25;

    if (stale) {
      this.initialValueUsd = navUsd;
      this.peakValueUsd = navUsd;
      this.baselineInitialized = true;
      logger.info("Stale NAV state from DB discarded — realigned to wallet", {
        navUsd: Math.round(navUsd * 100) / 100,
        peakNavUsd: Math.round(peakNavUsd * 100) / 100,
        initialNavUsd: Math.round(initialNavUsd * 100) / 100,
      });
      return;
    }

    this.initialValueUsd = initialNavUsd;
    this.peakValueUsd = Math.max(peakNavUsd, navUsd);
    this.baselineInitialized = true;
    logger.info("Portfolio NAV restored from database", {
      peakNavUsd: Math.round(this.peakValueUsd * 100) / 100,
      initialNavUsd: Math.round(this.initialValueUsd * 100) / 100,
      navUsd: Math.round(navUsd * 100) / 100,
    });
  }

  /**
   * Reset inflated peak / initial when they no longer match on-chain NAV
   * (e.g. after selling all positions or purging phantom trades).
   */
  realignNavBaselineIfStale(navUsd: number) {
    if (!this.baselineInitialized || !Number.isFinite(navUsd) || navUsd <= 0) return;

    const peakRatio = this.peakValueUsd / navUsd;
    const stalePeak = peakRatio > 1.25 || peakRatio < 0.5;
    if (!stalePeak) return;

    const oldPeak = this.peakValueUsd;
    this.peakValueUsd = Math.max(navUsd, this.initialValueUsd);
    logger.info("Portfolio peak NAV realigned to wallet (deposit baseline kept)", {
      navUsd: Math.round(navUsd * 100) / 100,
      oldPeak: Math.round(oldPeak * 100) / 100,
      initialNavUsd: Math.round(this.initialValueUsd * 100) / 100,
    });
  }

  getDayStartNav(): number {
    return this.dayStartNavUsd;
  }

  /** Seed Daily PnL mark from yesterday's last persisted NAV (UTC). */
  setDayStartNav(navUsd: number, utcDate = utcDateKey()) {
    if (!(navUsd > 0)) return;
    if (this.dayStartUtcDate === utcDate && this.dayStartNavUsd > 0) return;
    this.dayStartNavUsd = navUsd;
    this.dayStartUtcDate = utcDate;
    logger.info("Daily NAV mark set", {
      dayStartNavUsd: Math.round(navUsd * 100) / 100,
      utcDate,
    });
  }

  /**
   * Freeze yesterday's close as today's Daily baseline.
   * Call on every live NAV observation so the mark rolls at UTC midnight
   * and then stays fixed while current NAV ticks.
   */
  observeDayNav(navUsd: number, now = Date.now()) {
    if (!(navUsd > 0)) return;
    const today = utcDateKey(now);
    if (this.dayStartUtcDate === today && this.dayStartNavUsd > 0) {
      return;
    }
    if (this.dayStartUtcDate && this.dayStartUtcDate !== today && this.lastNavUsd > 0) {
      this.dayStartNavUsd = this.lastNavUsd;
      this.dayStartUtcDate = today;
      logger.info("Daily NAV mark rolled from yesterday close", {
        dayStartNavUsd: Math.round(this.dayStartNavUsd * 100) / 100,
        utcDate: today,
      });
      return;
    }
    this.dayStartNavUsd = navUsd;
    this.dayStartUtcDate = today;
  }

  exportNavState(): {
    peakNavUsd: number;
    initialNavUsd: number;
    baselineInitialized: boolean;
    dayStartNavUsd: number;
    dayStartUtcDate: string;
  } {
    return {
      peakNavUsd: this.peakValueUsd,
      initialNavUsd: this.initialValueUsd,
      baselineInitialized: this.baselineInitialized,
      dayStartNavUsd: this.dayStartNavUsd,
      dayStartUtcDate: this.dayStartUtcDate,
    };
  }

  /** Merge confirmed trades loaded from Neon or on-chain backfill (survives restarts). */
  hydrateTradeHistory(trades: import("../utils/types.js").TradeResult[]) {
    if (trades.length === 0) return;
    const merged = dedupeAndCleanTradeResults([...this.tradeHistory, ...trades]);
    this.tradeHistory = merged;
    for (const t of merged) this.persistentTradeIds.add(t.orderId);
    this.rebuildDailyTradeCounts();
    logger.info("Trade history hydrated from database", { count: trades.length });
  }

  /** Restore saved entry prices / peak PnL from Neon (survives restarts). */
  restorePersistedEntries(entries: Record<string, { avgEntryPrice: number; peakPnlPct?: number }>) {
    for (const [symbol, entry] of Object.entries(entries)) {
      if (entry.avgEntryPrice > 0) {
        this.persistedEntries.set(symbol.toUpperCase(), entry);
      }
    }
  }

  /** Export open-position cost basis for Neon persistence. */
  exportPositionEntries(): Record<string, { avgEntryPrice: number; peakPnlPct?: number }> {
    const out: Record<string, { avgEntryPrice: number; peakPnlPct?: number }> = {};
    for (const [symbol, pos] of this.positions) {
      if (pos.avgEntryPrice <= 0) continue;
      const peak = this.peakPnlPct.get(symbol);
      out[symbol] = {
        avgEntryPrice: pos.avgEntryPrice,
        ...(peak !== undefined ? { peakPnlPct: peak } : {}),
      };
    }
    return out;
  }

  private resolveEntryPrice(symbol: string, fallbackExisting?: number): number {
    const fromTrades = this.inferEntryPriceFromTrades(symbol);
    if (fromTrades && fromTrades > 0) return fromTrades;
    const persisted = this.persistedEntries.get(symbol.toUpperCase())?.avgEntryPrice;
    if (persisted && persisted > 0) return persisted;
    if (fallbackExisting && fallbackExisting > 0) return fallbackExisting;
    return 0;
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

  /** USD value of a held token (live price → avg entry fallback). */
  getPositionValueUsd(
    symbol: string,
    prices?: Map<string, number>
  ): number {
    const pos = this.positions.get(symbol.toUpperCase());
    if (!pos || pos.amount <= 0) return 0;
    const price =
      prices?.get(symbol.toUpperCase()) ??
      getLatestPrice(symbol) ??
      pos.avgEntryPrice;
    if (!(price > 0)) return 0;
    return pos.amount * price;
  }

  /** Positions worth at least MIN_POSITION_VALUE_USD — these consume portfolio slots. */
  isMaterialPosition(symbol: string, prices?: Map<string, number>): boolean {
    return this.getPositionValueUsd(symbol, prices) >= MIN_POSITION_VALUE_USD;
  }

  countMaterialPositions(prices?: Map<string, number>): number {
    let n = 0;
    for (const sym of this.positions.keys()) {
      if (this.isMaterialPosition(sym, prices)) n++;
    }
    return n;
  }

  getMaterialPositionSymbols(prices?: Map<string, number>): Set<string> {
    const out = new Set<string>();
    for (const sym of this.positions.keys()) {
      if (this.isMaterialPosition(sym, prices)) out.add(sym);
    }
    return out;
  }

  /**
   * Drop sub-minimum balances from the tracked map so dust doesn't block new buys.
   * On-chain dust may still exist — it's just excluded from slot limits and snapshots.
   */
  purgeDustPositions(prices: Map<string, number>): string[] {
    const purged: string[] = [];
    for (const [symbol, pos] of [...this.positions]) {
      const price =
        prices.get(symbol) ?? getLatestPrice(symbol) ?? pos.avgEntryPrice;
      const valueUsd = price > 0 ? pos.amount * price : 0;
      if (valueUsd >= MIN_POSITION_VALUE_USD) continue;
      this.positions.delete(symbol);
      this.peakPnlPct.delete(symbol);
      purged.push(symbol);
    }
    if (purged.length > 0) {
      logger.info("Dust positions purged from slot count", {
        symbols: purged,
        minUsd: MIN_POSITION_VALUE_USD,
      });
    }
    return purged;
  }

  /** Drop dust using latest market prices (safe before manual / risk checks). */
  purgeDustFromMarket(): string[] {
    const prices = new Map<string, number>();
    for (const sym of this.positions.keys()) {
      const p = getLatestPrice(sym);
      if (p && p > 0) prices.set(sym, p);
    }
    return this.purgeDustPositions(prices);
  }

  getTodayTradeCount(): number {
    const today = new Date().toISOString().split("T")[0];
    return this.dailyTradesByDate.get(today) || 0;
  }

  /** Confirmed successful swaps since a unix-ms timestamp. */
  countSuccessfulTradesSince(sinceMs: number): number {
    return this.tradeHistory.filter(
      (t) => t.success && t.timestamp >= sinceMs
    ).length;
  }

  /** Timestamp of the most recent successful asset buy, or 0. */
  lastSuccessfulBuyAt(): number {
    let latest = 0;
    for (const t of this.tradeHistory) {
      if (!t.success) continue;
      if (classifyAssetTrade(t.fromToken, t.toToken) === "buy") {
        latest = Math.max(latest, t.timestamp);
      }
    }
    return latest;
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
        const entry = this.resolveEntryPrice(symbol, existing.avgEntryPrice);
        if (entry > 0) existing.avgEntryPrice = entry;
      } else {
        const entry = this.resolveEntryPrice(symbol);
        this.positions.set(symbol, { amount, avgEntryPrice: entry });
        added.push(symbol);
      }
    }

    for (const [symbol, pos] of this.positions) {
      const peak = this.persistedEntries.get(symbol)?.peakPnlPct;
      if (peak !== undefined && !this.peakPnlPct.has(symbol)) {
        this.peakPnlPct.set(symbol, peak);
      }
    }

    this.refreshEntryPricesFromTrades();
    const dustRemoved = this.purgeDustPositions(prices);
    if (dustRemoved.length > 0) {
      for (const sym of dustRemoved) {
        if (!removed.includes(sym)) removed.push(sym);
      }
    }
    return { added, removed };
  }

  private collectSymbolsFromTradeHistory(): Set<string> {
    const symbols = new Set<string>();
    for (const t of this.tradeHistory) {
      if (!t.success) continue;
      const from = t.fromToken.toUpperCase();
      const to = t.toToken.toUpperCase();
      const side = classifyAssetTrade(from, to);
      if (side === "buy") symbols.add(to);
      else if (side === "sell") symbols.add(from);
    }
    return symbols;
  }

  /**
   * Replay buy/sell ledger for one token — weighted-average cost basis.
   */
  private replaySymbolLedger(symbol: string): { qty: number; avgEntryPrice: number } {
    const sym = symbol.toUpperCase();
    let qty = 0;
    let costBasis = 0;

    const trades = [...this.tradeHistory].sort((a, b) => a.timestamp - b.timestamp);
    for (const t of trades) {
      if (!t.success) continue;
      const from = t.fromToken.toUpperCase();
      const to = t.toToken.toUpperCase();
      const price = t.priceAtExecution > 0 ? t.priceAtExecution : 0;

      const side = classifyAssetTrade(from, to);
      const isBuy = side === "buy" && to === sym;
      const isSell = side === "sell" && from === sym;
      if (!isBuy && !isSell) continue;

      if (isBuy) {
        let tokenQty = parseTradeAmount(t.toAmount);
        if (tokenQty <= 0 && price > 0) {
          tokenQty = parseTradeAmount(t.fromAmount) / price;
        }
        if (tokenQty <= 0 || price <= 0) continue;
        costBasis += price * tokenQty;
        qty += tokenQty;
        continue;
      }

      let soldQty = parseTradeAmount(t.fromAmount);
      if (soldQty <= 0 && price > 0) {
        soldQty = parseTradeAmount(t.toAmount) / price;
      }
      if (soldQty <= 0 || qty <= 0) continue;
      const avg = costBasis / qty;
      const sold = Math.min(soldQty, qty);
      qty -= sold;
      costBasis = avg * qty;
      if (qty <= 1e-12) {
        qty = 0;
        costBasis = 0;
      }
    }

    if (qty <= 0 || costBasis <= 0) return { qty: 0, avgEntryPrice: 0 };
    return { qty, avgEntryPrice: costBasis / qty };
  }

  /**
   * Rebuild open positions from trade history after DB/chain hydrate.
   * When seedAmounts is true (cold start), pre-populates amounts before wallet sync.
   */
  rebuildPositionsFromTrades(opts?: { seedAmounts?: boolean }): number {
    let seeded = 0;
    for (const sym of this.collectSymbolsFromTradeHistory()) {
      const { qty, avgEntryPrice } = this.replaySymbolLedger(sym);
      if (qty <= 1e-12 || avgEntryPrice <= 0) continue;

      const existing = this.positions.get(sym);
      if (existing) {
        existing.avgEntryPrice = avgEntryPrice;
      } else if (opts?.seedAmounts && qty * avgEntryPrice >= MIN_POSITION_VALUE_USD) {
        this.positions.set(sym, { amount: qty, avgEntryPrice });
        seeded++;
      }
    }

    const updated = this.refreshEntryPricesFromTrades();
    this.purgeDustFromMarket();
    if (seeded > 0) {
      logger.info("Open positions seeded from trade history", { seeded, entriesRefreshed: updated });
    } else if (updated > 0) {
      logger.info("Entry prices rebuilt from trade history", { updated });
    }
    return seeded;
  }

  /**
   * Recompute weighted-average entry from confirmed buy/sell trade history.
   * Fixes positions that were synced from wallet using spot price as cost basis.
   */
  inferEntryPriceFromTrades(symbol: string): number | undefined {
    const { qty, avgEntryPrice } = this.replaySymbolLedger(symbol);
    if (qty <= 0 || avgEntryPrice <= 0) return undefined;
    return avgEntryPrice;
  }

  /** Apply trade-derived entry prices to every open position when available. */
  refreshEntryPricesFromTrades(): number {
    let updated = 0;
    for (const [symbol, pos] of this.positions) {
      const inferred = this.inferEntryPriceFromTrades(symbol);
      if (inferred && inferred > 0 && Math.abs(inferred - pos.avgEntryPrice) / inferred > 0.0001) {
        pos.avgEntryPrice = inferred;
        updated++;
      }
    }
    if (updated > 0) {
      logger.info("Entry prices refreshed from trade history", { updated });
    }
    return updated;
  }

  /**
   * FIFO realized PnL from matched buy→sell of assets only.
   * Funding↔funding (USDT/BNB) and orphan sells with no prior buy are ignored.
   */
  getClosedTradeStats(): {
    closedSells: number;
    wins: number;
    losses: number;
    winRate: number;
    realizedPnl: number;
    costClosed: number;
    dailyRealizedPnl: number;
    sellPnlByOrderId: Map<string, number>;
  } {
    const ledgers = new Map<string, { qty: number; cost: number }>();
    const sellPnlByOrderId = new Map<string, number>();
    let wins = 0;
    let losses = 0;
    let closedSells = 0;
    let realizedPnl = 0;
    let costClosed = 0;
    let dailyRealizedPnl = 0;
    const dayStart = utcDayStartMs();
    const cycleOpenAt = new Map<string, number>();

    const trades = [...this.tradeHistory]
      .filter((t) => t.success)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const t of trades) {
      const from = t.fromToken.toUpperCase();
      const to = t.toToken.toUpperCase();
      const price = t.priceAtExecution > 0 ? t.priceAtExecution : 0;
      const side = classifyAssetTrade(from, to);
      const synth = isSyntheticTradeHash(t.txHash);

      if (side === "buy") {
        const sym = to;
        let tokenQty = parseTradeAmount(t.toAmount);
        if (tokenQty <= 0 && price > 0) {
          tokenQty = parseTradeAmount(t.fromAmount) / price;
        }
        if (tokenQty <= 0 || price <= 0) continue;
        const cur = ledgers.get(sym) ?? { qty: 0, cost: 0 };
        if (cur.qty <= 1e-12 && !synth) cycleOpenAt.set(sym, t.timestamp);
        cur.cost += price * tokenQty;
        cur.qty += tokenQty;
        ledgers.set(sym, cur);
        continue;
      }

      if (side !== "sell") continue;

      const ledger = ledgers.get(from);
      if (!ledger || ledger.qty <= 0) continue;

      let soldQty = parseTradeAmount(t.fromAmount);
      if (soldQty <= 0 && price > 0) {
        soldQty = parseTradeAmount(t.toAmount) / price;
      }
      if (soldQty <= 0) continue;

      let proceeds = parseTradeAmount(t.toAmount);
      if (proceeds <= 0 && price > 0) proceeds = soldQty * price;

      const avgEntry = ledger.cost / ledger.qty;
      const sold = Math.min(soldQty, ledger.qty);
      const cost = avgEntry * sold;
      const pnl = proceeds - cost;

      ledger.qty -= sold;
      ledger.cost = ledger.qty > 0 ? avgEntry * ledger.qty : 0;
      if (ledger.qty <= 1e-12) ledgers.delete(from);
      else ledgers.set(from, ledger);

      closedSells++;
      costClosed += cost;
      realizedPnl += pnl;
      const openedToday = (cycleOpenAt.get(from) ?? 0) >= dayStart;
      if (t.timestamp >= dayStart && !synth && openedToday) dailyRealizedPnl += pnl;
      if (ledger.qty <= 1e-12) cycleOpenAt.delete(from);
      sellPnlByOrderId.set(t.orderId, pnl);
      if (pnl >= 0) wins++;
      else losses++;
    }

    const winRate = closedSells > 0 ? (wins / closedSells) * 100 : 0;
    return {
      closedSells,
      wins,
      losses,
      winRate,
      realizedPnl,
      costClosed,
      dailyRealizedPnl,
      sellPnlByOrderId,
    };
  }

  /**
   * Write FIFO realized PnL onto sell rows that are missing it (chain backfill).
   * Returns trades whose `realizedPnl` changed so the caller can persist them.
   */
  annotateSellRealizedPnl(): TradeResult[] {
    const { realizedPnl, sellPnlByOrderId } = this.getClosedTradeStats();
    this.realizedPnlUsd = realizedPnl;
    const updated: TradeResult[] = [];
    for (const t of this.tradeHistory) {
      const pnl = sellPnlByOrderId.get(t.orderId);
      if (pnl === undefined) continue;
      if (t.realizedPnl === pnl) continue;
      t.realizedPnl = pnl;
      updated.push(t);
    }
    return updated;
  }

  /** Drop Binance aggregates only when a real 0x hash exists for the same symbol+side. */
  purgeBinanceAggregateTrades(): number {
    const covered = realSymbolSideKeys(this.tradeHistory);
    const before = this.tradeHistory.length;
    this.tradeHistory = this.tradeHistory.filter((t) => {
      if (!t.txHash?.startsWith("binance-web3-")) return true;
      const key = symbolSideKey(t);
      if (key && covered.has(key)) {
        this.persistentTradeIds.delete(t.orderId);
        return false;
      }
      return true;
    });
    const removed = before - this.tradeHistory.length;
    if (removed > 0) this.rebuildDailyTradeCounts();
    return removed;
  }

  /** Drop trades without a confirmed tx hash and rebuild daily counters. */
  purgeUnconfirmedTrades(isConfirmed: (txHash: string | undefined) => boolean) {
    const kept = this.tradeHistory.filter(
      (t) => this.persistentTradeIds.has(t.orderId) || isConfirmed(t.txHash)
    );
    if (kept.length === this.tradeHistory.length) return 0;

    const removed = this.tradeHistory.length - kept.length;
    this.tradeHistory = kept;
    this.rebuildDailyTradeCounts();
    return removed;
  }

  /**
   * Remove "successful" buys that aren't backed by on-chain holdings.
   * These appear when a swap reports a hash but never settled.
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
    const allowed = new Set(["USDT", "USDC", "U", "USD1", "BNB"]);
    if (!allowed.has(funding)) {
      logger.warn("Buy rejected — payment token is not campaign-eligible", { symbol, funding });
      return;
    }
    if (funding !== "BNB" && amountUsd > this.cashUsd) {
      logger.warn("Buy exceeds cash", { symbol, amountUsd, cash: this.cashUsd, funding });
      return;
    }
    if (funding !== "BNB") this.cashUsd -= amountUsd;

    const existing = this.positions.get(symbol);
    if (existing) {
      const totalCost = existing.avgEntryPrice * existing.amount + price * tokenAmount;
      const totalAmount = existing.amount + tokenAmount;
      existing.avgEntryPrice = totalCost / totalAmount;
      existing.amount = totalAmount;
    } else {
      this.positions.set(symbol, { amount: tokenAmount, avgEntryPrice: price });
    }

    const lotList = this.lots.get(symbol) ?? [];
    lotList.push({ qty: tokenAmount, price });
    this.lots.set(symbol, lotList);

    const pos = this.positions.get(symbol);
    if (pos && pos.avgEntryPrice > 0) {
      this.persistedEntries.set(symbol.toUpperCase(), {
        avgEntryPrice: pos.avgEntryPrice,
        peakPnlPct: this.peakPnlPct.get(symbol),
      });
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

    let remaining = tokenAmount;
    let costBasis = 0;
    const lotList = this.lots.get(symbol) ?? [];
    while (remaining > 1e-12 && lotList.length > 0) {
      const lot = lotList[0]!;
      const take = Math.min(lot.qty, remaining);
      costBasis += take * lot.price;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-12) lotList.shift();
    }
    if (lotList.length > 0) this.lots.set(symbol, lotList);
    else this.lots.delete(symbol);

    if (costBasis <= 0) {
      costBasis = existing.avgEntryPrice * tokenAmount;
    }
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

  /** Merge or replace a confirmed on-chain trade (by tx hash + side). */
  upsertChainTrade(trade: import("../utils/types.js").TradeResult) {
    if (!trade.txHash) return;
    const key = tradeDedupeKey(trade);
    const idx = this.tradeHistory.findIndex((t) => tradeDedupeKey(t) === key);
    if (idx >= 0) {
      this.tradeHistory[idx] = preferTradeRecord(this.tradeHistory[idx]!, trade);
    } else if (!this.tradeHistory.some((t) => t.orderId === trade.orderId)) {
      this.tradeHistory.push(trade);
    }
    this.tradeHistory = dedupeAndCleanTradeResults(this.tradeHistory);
    this.persistentTradeIds.add(trade.orderId);
  }

  recordTrade(result: TradeResult) {
    this.tradeHistory.push(result);
    this.tradeHistory = dedupeAndCleanTradeResults(this.tradeHistory);
  }

  private incrementDailyTrades() {
    const today = new Date().toISOString().split("T")[0];
    this.dailyTradesByDate.set(today, (this.dailyTradesByDate.get(today) || 0) + 1);
  }

  snapshot(
    currentPrices: Map<string, number>,
    exitRules?: {
      stopLossPct: number;
      takeProfitPct: number;
      trailingActivatePct?: number;
    }
  ): PortfolioSnapshot {
    const snap = this.buildSnapshot(currentPrices, exitRules);
    this.snapshots.push(this.toNavPoint(snap));
    this.trimSnapshots();
    return snap;
  }

  /** Live NAV / exits without appending to the equity-curve history. */
  peekSnapshot(
    currentPrices: Map<string, number>,
    exitRules?: {
      stopLossPct: number;
      takeProfitPct: number;
      trailingActivatePct?: number;
    }
  ): PortfolioSnapshot {
    return this.buildSnapshot(currentPrices, exitRules);
  }

  private buildSnapshot(
    currentPrices: Map<string, number>,
    exitRules?: {
      stopLossPct: number;
      takeProfitPct: number;
      trailingActivatePct?: number;
    }
  ): PortfolioSnapshot {
    const positionSnapshots: PortfolioPosition[] = [];
    let positionsValueUsd = 0;
    const slPct = exitRules?.stopLossPct ?? 0;
    const tpPct = exitRules?.takeProfitPct ?? 0;

    for (const [symbol, pos] of this.positions) {
      const currentPrice = currentPrices.get(symbol) || pos.avgEntryPrice;
      const valueUsd = pos.amount * currentPrice;
      if (valueUsd < MIN_POSITION_VALUE_USD) continue;
      positionsValueUsd += valueUsd;

      const entry = pos.avgEntryPrice;
      const pnlPct = entry > 0 ? ((currentPrice - entry) / entry) * 100 : 0;
      const peak = this.peakPnlPct.get(symbol);
      const entryFromTrades = this.inferEntryPriceFromTrades(symbol);

      const snap: PortfolioPosition = {
        symbol,
        amount: pos.amount,
        avgEntryPrice: entry,
        currentPrice,
        unrealizedPnl: (currentPrice - entry) * pos.amount,
        unrealizedPnlPct: pnlPct,
        weight: 0,
      };

      if (exitRules && entry > 0) {
        snap.stopLossPrice = entry * (1 - Math.abs(slPct) / 100);
        snap.takeProfitPrice = entry * (1 + tpPct / 100);
        snap.distanceToStopPct = pnlPct + Math.abs(slPct);
        snap.distanceToTakeProfitPct = tpPct - pnlPct;
        if (peak !== undefined) snap.peakPnlPct = peak;
      }
      if (entryFromTrades && entryFromTrades > 0) {
        snap.entryFromTrades = Math.abs(entryFromTrades - entry) / entryFromTrades < 0.001;
      }

      positionSnapshots.push(snap);
    }

    const totalValueUsd = this.cashUsd + this.gasReserveUsd + positionsValueUsd;
    this.observeDayNav(totalValueUsd);
    this.lastNavUsd = totalValueUsd;

    for (const p of positionSnapshots) {
      p.weight = totalValueUsd > 0 ? ((p.amount * p.currentPrice) / totalValueUsd) * 100 : 0;
    }

    // Only track peak / drawdown once the baseline reflects real capital.
    if (this.baselineInitialized && totalValueUsd > this.peakValueUsd) {
      this.peakValueUsd = totalValueUsd;
    }

    const drawdownPct = this.computeDrawdown(totalValueUsd);

    const closed = this.getClosedTradeStats();
    this.realizedPnlUsd = closed.realizedPnl;
    const unrealizedPnl = positionSnapshots.reduce((s, p) => s + p.unrealizedPnl, 0);
    const costOpen = positionSnapshots.reduce((s, p) => s + p.avgEntryPrice * p.amount, 0);
    const tradedCost = costOpen + closed.costClosed;
    const assetPnl = closed.realizedPnl + unrealizedPnl;

    const deposit = this.baselineInitialized ? this.initialValueUsd : 0;
    const totalPnl = deposit > 0 ? totalValueUsd - deposit : assetPnl;
    const totalPnlPct =
      deposit > 0
        ? (totalPnl / deposit) * 100
        : tradedCost > 0
          ? (assetPnl / tradedCost) * 100
          : 0;
    const dailyPnl =
      this.dayStartNavUsd > 0 ? totalValueUsd - this.dayStartNavUsd : closed.dailyRealizedPnl;
    const dailyPnlPct =
      this.dayStartNavUsd > 0 ? (dailyPnl / this.dayStartNavUsd) * 100 : 0;

    return {
      timestamp: Date.now(),
      totalValueUsd,
      cashUsd: this.cashUsd,
      positions: positionSnapshots,
      dailyPnl,
      totalPnl,
      totalPnlPct,
      realizedPnl: closed.realizedPnl,
      ...(this.baselineInitialized
        ? { initialNavUsd: this.initialValueUsd }
        : {}),
      ...(this.dayStartNavUsd > 0 ? { dayStartNavUsd: this.dayStartNavUsd } : {}),
      gasReserveUsd: this.gasReserveUsd,
      maxDrawdownPct: drawdownPct,
      tradeCount: this.tradeHistory.length,
    };
  }

  private toNavPoint(snap: PortfolioSnapshot): PortfolioSnapshot {
    return {
      timestamp: snap.timestamp,
      totalValueUsd: snap.totalValueUsd,
      cashUsd: snap.cashUsd,
      positions: [],
      dailyPnl: snap.dailyPnl,
      totalPnl: snap.totalPnl,
      totalPnlPct: snap.totalPnlPct,
      realizedPnl: snap.realizedPnl,
      ...(snap.initialNavUsd != null ? { initialNavUsd: snap.initialNavUsd } : {}),
      ...(snap.dayStartNavUsd != null ? { dayStartNavUsd: snap.dayStartNavUsd } : {}),
      gasReserveUsd: snap.gasReserveUsd,
      maxDrawdownPct: snap.maxDrawdownPct,
      tradeCount: snap.tradeCount,
    };
  }

  private trimSnapshots() {
    const n = this.snapshots.length;
    if (n === 0) return;

    const compact = (s: PortfolioSnapshot) =>
      s.positions.length > 0 ? this.toNavPoint(s) : s;

    if (n <= MAX_NAV_POINTS) {
      if (this.snapshots.some((s) => s.positions.length > 0)) {
        this.snapshots = this.snapshots.map(compact);
      }
      return;
    }

    const step = n / MAX_NAV_POINTS;
    const next: PortfolioSnapshot[] = [];
    for (let i = 0; i < MAX_NAV_POINTS - 1; i++) {
      next.push(compact(this.snapshots[Math.min(n - 1, Math.floor(i * step))]!));
    }
    next.push(compact(this.snapshots[n - 1]!));
    this.snapshots = next;
  }

  /** Downsampled equity points for the dashboard chart — never full position history. */
  getChartPoints(): Array<{
    timestamp: number;
    totalValueUsd: number;
    maxDrawdownPct: number;
  }> {
    this.trimSnapshots();
    return this.snapshots.map((s) => ({
      timestamp: s.timestamp,
      totalValueUsd: Math.round(s.totalValueUsd * 100) / 100,
      maxDrawdownPct: Math.round(s.maxDrawdownPct * 100) / 100,
    }));
  }

  getMaxDrawdown(): number {
    if (this.lastNavUsd > 0) {
      return this.computeDrawdown(this.lastNavUsd);
    }
    return this.computeDrawdown(this.estimateNavUsd());
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
    return dedupeAndCleanTradeResults(this.tradeHistory);
  }

  getSnapshots(): PortfolioSnapshot[] {
    this.trimSnapshots();
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
      const entry = this.resolveEntryPrice(symbol, pos.avgEntryPrice);
      if (entry > 0 && (!(pos.avgEntryPrice > 0) || !Number.isFinite(pos.avgEntryPrice))) {
        pos.avgEntryPrice = entry;
      }
      if (!(entry > 0) || !Number.isFinite(entry)) {
        logger.warn("Protective exit skipped — no valid entry price", { symbol, avgEntry: pos.avgEntryPrice });
        continue;
      }

      const currentPrice = currentPrices.get(symbol) || entry;
      if (!(currentPrice > 0) || !Number.isFinite(currentPrice)) continue;

      const pnlPct = ((currentPrice - entry) / entry) * 100;
      if (!Number.isFinite(pnlPct)) {
        logger.warn("Protective exit skipped — PnL is not finite", { symbol, entry, currentPrice, pnlPct });
        continue;
      }

      const prevPeak = this.peakPnlPct.get(symbol);
      const peak = Number.isFinite(prevPeak) ? Math.max(prevPeak as number, pnlPct) : pnlPct;
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

      // 3. Trailing stop — hidden from the desk UI. Off when activate/giveback are 0.
      if (
        params.trailingActivatePct > 0 &&
        params.trailingGivebackPct > 0 &&
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
