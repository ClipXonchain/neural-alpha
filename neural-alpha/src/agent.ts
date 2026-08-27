import type { AgentConfig, MarketData, CycleResult, TradeResult, PortfolioHolding, TradeOrder, PortfolioSnapshot } from "./utils/types.js";
import { loadConfig, buildDefaultWatchlist, MOMENTUM_CORE, MOMENTUM_VOLATILE, ANCHOR_TOKENS, MAX_WATCHLIST_SIZE, ELIGIBLE_TOKENS, FULL_SCAN_INTERVAL, FULL_SCAN_BATCH_SIZE, FULL_SCAN_PROMOTE_COUNT, isEligibleToken, isStablecoin, isTradableToken, MIN_TRADABLE_PRICE_USD, EXCLUDED_TOKENS, BSC_CHAIN, MIN_POSITION_VALUE_USD } from "./config.js";
import { buildMarketData, getLatestPrice, recordPrice, CMC_ENDPOINTS, seedPriceHistory, getHistoryLength, hasRealHistory, parseCmcQuotesBatch, parseCmcTrending, unwrapX402Response } from "./data/market.js";
import { fetchNewsFeed } from "./data/news.js";
import { analyzeMarkets, selectTrades } from "./strategy/index.js";
import { getSessionProfile } from "./strategy/presets.js";
import { getSessionClock, isSessionPolicy } from "./strategy/session.js";
import type { SessionClock } from "./strategy/session.js";
import { resolveBscTokenAddress, hasBscSwapAddress, knownBscAddress, trustWalletIconUrl } from "./integrations/bsc-token-addresses.js";
import { computeSignals, getTokenMomentumMetrics, getTokenDisplayMetrics } from "./strategy/signals.js";
import { enrichSignalsWithAi, applyAiInsight } from "./strategy/ai-analyst.js";
import type { AiSignalInsight } from "./strategy/ai-analyst.js";
import { analyzeNewsSentiment, type NewsSentiment } from "./strategy/news-sentiment.js";
import { getCmcMacro, refreshCmcMacro } from "./strategy/cmc-macro.js";
import { RiskManager } from "./risk/manager.js";
import { PortfolioTracker } from "./risk/portfolio.js";
import {
  blacklistToken as addUserBlacklist,
  unblacklistToken as removeUserBlacklist,
  getUserBlacklistedTokens,
  restoreUserBlacklist,
} from "./risk/token-blacklist.js";
import {
  validateAndCreateOrder,
  buildSwapParams,
  buildQuoteParams,
  processSwapResult,
  applyTradeToPortfolio,
  isOnChainTxHash,
  floorTokenAmount,
} from "./execution/executor.js";
import { logger } from "./utils/logger.js";
import {
  brainAgentStarted,
  brainCycleDone,
  brainCycleStart,
  brainEmergency,
  brainLoopsStarted,
  brainPortfolioContext,
  brainProtectiveExit,
  brainProtectiveWatch,
  brainQueuedTrades,
  brainBuyPacing,
  brainRefreshLoopStarted,
  brainSession,
  brainCmcMacro,
  brainSignalOverview,
  brainSignalPulse,
  brainTradeExecuted,
  brainTradeFailed,
  brainTradeSkipped,
} from "./utils/brain-log.js";
import { getAgentStore } from "./db/store.js";
import { fetchBscTokenBalances, scanWalletViaCliSubprocess } from "./integrations/bscscan.js";
import { fetchWalletTradeHistory } from "./integrations/trade-history.js";
import { fetchRpcRecentTradeHistory } from "./integrations/bsc-rpc-trade-history.js";
import { fetchBinanceWeb3Holdings, fetchWalletPositions, type BinanceWeb3Position } from "./integrations/binance-web3-wallet.js";
import {
  enrichSymbolsFromBinance,
  iconFromWalletRow,
  normalizeBinanceIcon,
  listKnownBscTokenSymbols,
  isPlausibleLivePrice,
  type BinanceLiveQuote,
} from "./integrations/binance-web3-market.js";
import { campaignQualification, loadCampaignState } from "./integrations/campaign.js";
import {
  startAgenticSignin,
  verifyAgenticSignin,
} from "./integrations/agentic-wallet-bridge.js";
import {
  completeCmcCampaignCall,
  submitStudioAnalysis,
  pollStudioJob,
} from "./integrations/campaign-x402.js";
import { tickerFromBstock } from "./integrations/bstock.js";

/** CMC / eligible-universe refresh. Live Binance quotes pulse faster than this. */
const DEEP_SCAN_MS = 180_000;
/** ClipX news cadence — not needed on every live price tick. */
const NEWS_REFRESH_MS = 120_000;

/**
 * Core autonomous trading agent — Neural Alpha.
 *
 * Architecture:
 *   Binance Web3 bStock quotes + CMC x402 → Strategy → Risk → Agentic Wallet swap → BSC
 *
 * All live execution goes through Binance Agentic Wallet (`baw`) — MPC keyless,
 * no local private keys. Campaign PnL only counts eligible bStock trades via AW.
 */

export interface McpBridge {
  getTokenPrice(chain: string, token: string): Promise<{ price: number } | null>;
  getWalletBalance(chain: string): Promise<{ balance: string } | null>;
  getSwapQuote(params: ReturnType<typeof buildQuoteParams>): Promise<Record<string, unknown> | null>;
  executeSwap(params: ReturnType<typeof buildSwapParams>): Promise<Record<string, unknown>>;
  getAddress(chain: string): Promise<{ address: string } | null>;
  x402Request(url: string, maxPayment: string): Promise<Record<string, unknown> | null>;
  getTrendingTokens(limit: number): Promise<Array<{ symbol: string }> | null>;
  checkTokenRisk(chain: string, token?: string): Promise<Record<string, unknown> | null>;
  /** USDT (or base stable) balance for the agent wallet */
  getStablecoinBalance?(chain: string): Promise<{ balance: number; symbol: string } | null>;
  /** Full on-chain token holdings for the agent wallet (live mode). */
  getPortfolio?(chain: string): Promise<PortfolioHolding[] | null>;
  /** Direct on-chain balance for a single token symbol (reliable fallback). */
  getTokenBalance?(chain: string, symbol: string): Promise<PortfolioHolding | null>;
  switchWalletMode?(mode: "local" | "walletconnect"): Promise<Record<string, unknown> | null>;
  getWalletStatus?(): Promise<Record<string, unknown> | null>;
  competitionRegister?(): Promise<Record<string, unknown> | null>;
  competitionStatus?(): Promise<Record<string, unknown> | null>;
}

export interface CampaignSnapshot {
  registered: boolean;
  registrationOpen: boolean;
  cmcCalls: number;
  studioCalls: number;
  minCmcCalls: number;
  minStudioCalls: number;
  cmcComplete: boolean;
  studioComplete: boolean;
  joinUrl: string;
  docsUrl: string;
  active: boolean;
}

export interface WalletInfo {
  address: string | null;
  bnbBalance: number;
  usdtBalance: number;
  walletMode: string;
  walletState: string;
  registered: boolean;
  registrationOpen: boolean;
  binancePositions?: BinanceWeb3Position[];
  campaign?: CampaignSnapshot;
}

export class TradingAgent {
  private config: AgentConfig;
  private portfolio: PortfolioTracker;
  private riskManager: RiskManager;
  private mcp: McpBridge;
  private cycleCount = 0;
  private running = false;
  private runGeneration = 0;
  private watchlist: string[];
  private lastSignals: Map<string, number> = new Map();
  private lastSignalConfidence: Map<string, number> = new Map();
  private lastNewsSentiment: Map<string, NewsSentiment> = new Map();
  private lastNewsCount = 0;
  private lastAiInsights = new Map<string, AiSignalInsight>();
  private lastTradeSignals = new Map<string, import("./utils/types.js").TradeSignal>();
  private bridgeSource = "unknown";
  private x402Payment = process.env.CMC_X402_MAX_PAYMENT || "10000";
  private startedAt = Date.now();
  /** Autonomous swap failures — prevents approve+retry spam on the same token. */
  private failedSwapUntil = new Map<string, number>();
  private cycleInProgress = false;
  private lastCycleCompletedAt = 0;
  private lastCycleDurationMs = 0;
  private lastCycleTradesExecuted = 0;
  private lastCycleSignalsQueued = 0;
  private tradeHistoryBackfillRunning = false;
  private tradeHistoryBackfillQueued = false;
  private lastTradeHistoryBackfillAt = 0;
  /** Independent signal refresh loop (decoupled from trade cycle). */
  private signalRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private signalRefreshInProgress = false;
  private signalRefreshPromise: Promise<MarketData[]> | null = null;
  private signalRefreshCount = 0;
  private lastSignalRefreshAt = 0;
  private lastFullScanAt = 0;
  private lastNewsFetchedAt = 0;
  /** Reuse dashboard JSON for ~1s so SSE + /api/state don't recompute indicators. */
  private stateCache: { at: number; value: AgentState } | null = null;
  /** Independent SL/TP/trailing check (decoupled from trade cycle). */
  private protectiveExitTimer: ReturnType<typeof setInterval> | undefined;
  private protectiveExitInProgress = false;
  private tokenIcons = new Map<string, string>();
  private livePrices = new Map<string, BinanceLiveQuote>();
  private lastMarketData: MarketData[] = [];

  constructor(mcp: McpBridge, initialCashUsd = 1000, bridgeSource = "unknown") {
    this.config = loadConfig();
    // Live mode defers the NAV baseline until the real on-chain balance is
    // synced, so a placeholder cash value can't trigger a false drawdown.
    this.portfolio = new PortfolioTracker(initialCashUsd, this.config.mode === "live");
    this.riskManager = new RiskManager(this.config, this.portfolio);
    this.mcp = mcp;
    this.bridgeSource = bridgeSource;
    this.watchlist = buildDefaultWatchlist();

    logger.info("Trading agent initialized", {
      mode: this.config.mode,
      initialCash: initialCashUsd,
      watchlist: this.watchlist,
      maxDrawdown: this.config.maxDrawdownPct,
      maxPositionSize: this.config.maxPositionSizeUsd,
      tradeInterval: this.config.tradeIntervalMs,
      signalRefresh: this.config.signalRefreshMs,
      protectiveExitCheck: this.config.protectiveExitCheckMs,
      autoExitEnabled: this.config.autoExitEnabled,
    });
  }

  async start() {
    if (this.running) {
      logger.info("Agent start requested while already running");
      return;
    }

    this.running = true;
    const generation = ++this.runGeneration;
    this.startedAt = Date.now();

    await this.bootstrapPersistence();

    // Live mode: import real on-chain holdings, then seed cash + NAV baseline.
    // Positions are imported first so the baseline reflects total wallet value.
    if (this.config.mode === "live") {
      try {
        await this.syncOnChainPositions();
      } catch (err) {
        logger.warn("Initial on-chain position import failed", { error: String(err) });
      }
      if (this.mcp.getStablecoinBalance) {
        try {
          await this.syncWalletCapital();
        } catch (err) {
          logger.warn("Initial wallet sync failed", { error: String(err) });
        }
      }

      if (this.portfolio.hasPendingNavRestore()) {
        const nav = this.portfolio.estimateNavUsd();
        if (nav > 0) this.portfolio.applyPendingNavRestore(nav);
      }

      this.scheduleTradeHistoryBackfill([], { force: true });
    }

    // Signal refresh loop — populates dashboard before / between trade cycles.
    this.startSignalRefreshLoop(generation);
    this.startProtectiveExitLoop(generation);

    this.getWalletInfo().catch(() => {});

    logger.info("Agent started — entering trading loop", {
      interval: `${this.config.tradeIntervalMs / 1000}s`,
      sessionPolicy: this.config.sessionPolicy,
    });
    brainAgentStarted(
      this.config.mode,
      this.config.tradeIntervalMs,
      this.config.signalRefreshMs
    );

    while (this.running && generation === this.runGeneration) {
      try {
        const result = await this.runCycle();
        logger.info("Cycle complete", {
          cycle: result.cycleId,
          tradesExecuted: result.tradesExecuted.length,
          portfolioValue: Math.round(result.portfolioSnapshot.totalValueUsd * 100) / 100,
          pnlPct: Math.round(result.portfolioSnapshot.totalPnlPct * 100) / 100,
          drawdown: Math.round(result.portfolioSnapshot.maxDrawdownPct * 100) / 100,
          duration: `${result.duration}ms`,
        });
      } catch (err) {
        logger.error("Cycle failed", { error: String(err) });
      }

      if (this.running && generation === this.runGeneration) {
        await sleep(this.config.tradeIntervalMs);
      }
    }
  }

  stop() {
    if (!this.running) {
      logger.info("Agent stop requested while already stopped");
      return;
    }

    this.running = false;
    this.runGeneration++;
    if (this.signalRefreshTimer) {
      clearInterval(this.signalRefreshTimer);
      this.signalRefreshTimer = undefined;
    }
    if (this.protectiveExitTimer) {
      clearInterval(this.protectiveExitTimer);
      this.protectiveExitTimer = undefined;
    }
    logger.info("Agent stop requested");
  }

  /**
   * Execute one full trading cycle:
   * 1. Fetch bStock quotes (Binance Web3 + CMC fallback)
   * 2. Compute technical signals
   * 3. Generate trade decisions
   * 4. Validate against risk guardrails
   * 5. Execute approved trades via Agentic Wallet
   * 6. Update portfolio and log results
   */
  async runCycle(): Promise<CycleResult> {
    const startTime = Date.now();
    this.cycleCount++;
    const cycleId = this.cycleCount;
    this.cycleInProgress = true;

    logger.info(`=== Cycle ${cycleId} ===`);

    try {

    if (this.config.mode === "live") {
      await this.reconcileLivePortfolio();
    }

    // Step 1: Refresh market data + signals (full scan on cycle 1 and every N cycles).
    const fullScan =
      this.cycleCount <= 1 || this.cycleCount % FULL_SCAN_INTERVAL === 0;
    this.applySessionSizing();
    const markets = await this.runMarketSignalRefresh({
      fullScan,
      force: true,
    });
    brainCycleStart(cycleId, markets.length, fullScan);
    brainSession(this.getSessionClock());

    const materialHeld = [...this.portfolio.getMaterialPositionSymbols()].sort();
    brainPortfolioContext(
      materialHeld,
      this.portfolio.cash,
      this.portfolio.getMaxDrawdown(),
      materialHeld.length,
      this.config.maxPortfolioTokens
    );

    // Step 2: Analyze markets and generate session-weighted signals.
    let signals = analyzeMarkets(
      markets,
      this.config,
      this.lastNewsSentiment,
      getCmcMacro()
    );
    this.rememberSignals(signals);
    brainSignalOverview(markets.length, signals);

    // Step 3: AI technical analysis on top actionable signals (optional)
    const technicalsMap = new Map(
      markets.map((m) => [m.symbol, computeSignals(m.symbol, m.price)] as const)
    );
    this.lastAiInsights = await enrichSignalsWithAi(
      signals,
      markets,
      technicalsMap
    );
    if (this.lastAiInsights.size > 0) {
      signals = signals.map((s) =>
        applyAiInsight(s, this.lastAiInsights.get(s.symbol.toUpperCase()))
      );
      this.rememberSignals(signals);
    }

    // Persist so scores from periodic full eligible-token scans remain visible.
    this.rememberSignals(signals);

    if (this.config.autoExitEnabled && materialHeld.length > 0) {
      brainProtectiveWatch(materialHeld);
    }

    // Step 3b: Protective exits — stop-loss, take-profit, trailing stop (optional).
    const currentPrices = new Map<string, number>();
    for (const m of markets) {
      currentPrices.set(m.symbol, m.price);
    }
    const trailingSells: import("./utils/types.js").TradeSignal[] = [];
    if (this.config.autoExitEnabled) {
      trailingSells.push(...this.buildProtectiveExitSignals(currentPrices));
      if (trailingSells.length > 0) {
        logger.risk("Protective exit triggered in trade cycle", {
          exits: trailingSells.map((s) => s.symbol),
        });
        brainProtectiveExit(
          trailingSells.map((s) => s.symbol),
          trailingSells.map((s) => s.reasons[0] ?? "stop/TP")
        );
      }
    }

    // Step 4: Select best trades (dust holdings do not consume portfolio slots).
    const existingPositions = this.portfolio.getMaterialPositionSymbols(currentPrices);
    const tradesToExecute = selectTrades(signals, this.config, existingPositions);

    const lastBuyAt = this.portfolio.lastSuccessfulBuyAt();
    const buyInterval = this.config.minBuyIntervalMs ?? 600_000;
    const buyWaitLeft = lastBuyAt > 0 ? buyInterval - (Date.now() - lastBuyAt) : 0;
    if (buyWaitLeft > 0) {
      const skipped = tradesToExecute.filter((t) => t.action === "buy");
      if (skipped.length > 0) {
        const waitMin = Math.max(1, Math.ceil(buyWaitLeft / 60_000));
        logger.info("New buys paused — waiting after last entry", {
          waitMin,
          lastBuyAt: new Date(lastBuyAt).toISOString(),
          skipped: skipped.map((s) => s.symbol),
        });
        brainBuyPacing(waitMin, skipped[0]?.symbol);
      }
      for (let i = tradesToExecute.length - 1; i >= 0; i--) {
        if (tradesToExecute[i]!.action === "buy") tradesToExecute.splice(i, 1);
      }
    }

    brainQueuedTrades(tradesToExecute);

    // Prepend protective exits (highest priority — always execute first)
    for (const ts of trailingSells) {
      if (!tradesToExecute.find((t) => t.symbol === ts.symbol)) {
        tradesToExecute.unshift(ts);
      }
    }

    // Step 5: Check for emergency mode.
    // High drawdown halts NEW BUYS but never force-liquidates — existing
    // positions are held so a temporary dip isn't locked in as a realized loss.
    if (this.riskManager.isEmergencyMode()) {
      logger.risk(
        "EMERGENCY MODE — high drawdown, new buys paused (positions held, no liquidation)",
        this.riskManager.riskSummary()
      );
      brainEmergency("Drawdown high — pausing new buys, keeping existing positions.");
      tradesToExecute.splice(0, tradesToExecute.length,
        ...tradesToExecute.filter((t) => t.action === "sell")
      );

      if (this.portfolio.getMaxDrawdown() >= this.config.maxDrawdownPct) {
        logger.risk("MAX DRAWDOWN REACHED — buying paused, holding positions (no auto-liquidation)");
      }
    }

    // Step 5: Execute trades (serial via baw — all validated signals this cycle)
    const tradeResults: TradeResult[] = [];
    for (const signal of tradesToExecute) {
      if (this.isInFailedSwapCooldown(signal.symbol)) continue;
      const result = await this.executeTrade(signal);
      if (result?.success) {
        tradeResults.push(result);
      }
    }

    // Step 6b: Re-sync with on-chain reality before snapshot so phantom
    // trades don't inflate peak NAV / drawdown.
    if (this.config.mode === "live") {
      await this.reconcileLivePortfolio(currentPrices);
    }

    // Step 7: Take portfolio snapshot
    const snapshot = this.portfolio.snapshot(currentPrices, {
      stopLossPct: this.config.stopLossPct,
      takeProfitPct: this.config.takeProfitPct,
      trailingActivatePct: this.config.trailingActivatePct,
    });
    await this.persistCycleSnapshot(cycleId, snapshot);

    // Step 8: Log risk summary
    logger.info("Risk status", this.riskManager.riskSummary());

    const duration = Date.now() - startTime;
    this.lastCycleCompletedAt = Date.now();
    this.lastCycleDurationMs = duration;
    this.lastCycleTradesExecuted = tradeResults.length;
    this.lastCycleSignalsQueued = tradesToExecute.length;

    const autoStatus = this.buildAutonomousStatus();
    logger.info("Autonomous cycle summary", {
      phase: autoStatus.phase,
      tradesExecuted: tradeResults.length,
      queued: tradesToExecute.length,
      tradesToday: autoStatus.tradesToday,
      tradesLast24h: autoStatus.tradesLast24h,
      session: autoStatus.session,
      nextCycleInSec: autoStatus.nextCycleInSec,
      blockReason: autoStatus.blockReason,
    });
    brainCycleDone(
      cycleId,
      tradeResults.length,
      tradesToExecute.length,
      autoStatus.phase,
      {
        nextCycleMin: autoStatus.nextCycleInSec != null ? autoStatus.nextCycleInSec / 60 : null,
        portfolioUsd: snapshot.totalValueUsd,
        tradesToday: autoStatus.tradesToday,
        durationSec: Math.round(duration / 1000),
      }
    );

    return {
      cycleId,
      timestamp: Date.now(),
      marketsAnalyzed: markets.length,
      signalsGenerated: signals,
      tradesExecuted: tradeResults,
      portfolioSnapshot: snapshot,
      duration,
    };
    } finally {
      this.cycleInProgress = false;
    }
  }

  /**
   * Background signal refresh — live Binance quotes on a short pulse,
   * independent of the trade cycle.
   */
  private startSignalRefreshLoop(generation: number) {
    void this.runMarketSignalRefresh({ fullScan: true, force: true });

    this.signalRefreshTimer = setInterval(() => {
      if (!this.running || generation !== this.runGeneration) return;
      if (this.signalRefreshInProgress) return;
      this.signalRefreshCount++;
      const fullScan =
        this.lastFullScanAt === 0 ||
        Date.now() - this.lastFullScanAt >= DEEP_SCAN_MS;
      void this.runMarketSignalRefresh({ fullScan });
    }, this.config.signalRefreshMs);

    logger.info("Signal refresh loop started", {
      intervalSec: this.config.signalRefreshMs / 1000,
    });
    brainRefreshLoopStarted(this.config.signalRefreshMs);
  }

  /**
   * Fast protective exit loop — SL / TP / trailing checks without running a
   * full buy/signal cycle. Decoupled from TRADE_INTERVAL_MS.
   */
  private startProtectiveExitLoop(generation: number) {
    if (this.protectiveExitTimer) {
      clearInterval(this.protectiveExitTimer);
      this.protectiveExitTimer = undefined;
    }
    if (!this.config.autoExitEnabled || this.config.protectiveExitCheckMs <= 0) {
      return;
    }

    void this.runProtectiveExitCheck({ refreshPrices: true });

    this.protectiveExitTimer = setInterval(() => {
      if (!this.running || generation !== this.runGeneration) return;
      if (this.protectiveExitInProgress) return;
      void this.runProtectiveExitCheck();
    }, this.config.protectiveExitCheckMs);

    logger.info("Protective exit loop started", {
      intervalSec: this.config.protectiveExitCheckMs / 1000,
      stopLossPct: this.config.stopLossPct,
      takeProfitPct: this.config.takeProfitPct,
    });
    brainLoopsStarted(
      Math.round(this.config.protectiveExitCheckMs / 1000),
      this.config.autoExitEnabled
    );
  }

  private buildProtectiveExitSignals(
    currentPrices: Map<string, number>
  ): import("./utils/types.js").TradeSignal[] {
    const riskExits = this.portfolio.getRiskManagedExits(currentPrices, {
      stopLossPct: this.config.stopLossPct,
      takeProfitPct: this.config.takeProfitPct,
      trailingActivatePct: this.config.trailingActivatePct,
      trailingGivebackPct: this.config.trailingGivebackPct,
    });
    return riskExits.map((exit) => ({
      symbol: exit.symbol,
      action: "sell" as const,
      strength: "strong_sell" as const,
      score: -100,
      reasons: [exit.reason],
      targetAllocationPct: 0,
      confidence: 1,
    }));
  }

  /** Live prices for open positions — Binance live → market cache → wallet fallback. */
  private buildPositionPrices(): Map<string, number> {
    const prices = new Map<string, number>();
    for (const sym of this.portfolio.getMaterialPositionSymbols()) {
      const live = this.livePrices.get(sym);
      if (live?.price && live.price > 0) {
        prices.set(sym, live.price);
        continue;
      }
      const cached = getLatestPrice(sym);
      if (cached && cached > 0) prices.set(sym, cached);
    }
    for (const md of this.lastMarketData) {
      if (!prices.has(md.symbol) && md.price > 0) {
        prices.set(md.symbol, md.price);
      }
    }
    return prices;
  }

  private async fetchPricesForPositions(symbols: string[]): Promise<Map<string, number>> {
    const prices = this.buildPositionPrices();
    const missing = symbols.filter((s) => !prices.has(s));
    if (missing.length === 0) return prices;

    await Promise.all(
      missing.map(async (sym) => {
        try {
          const q = await this.mcp.getTokenPrice(BSC_CHAIN, sym);
          if (q?.price && q.price > 0) prices.set(sym, q.price);
        } catch {
          /* best-effort */
        }
      })
    );
    return prices;
  }

  /**
   * Check SL/TP/trailing and execute sells. Runs on its own timer (default 60s)
   * so overnight gap risk can be cut without waiting for the next trade cycle.
   */
  private async runProtectiveExitCheck(
    opts: { refreshPrices?: boolean } = {}
  ): Promise<import("./utils/types.js").TradeResult[]> {
    if (!this.config.autoExitEnabled || !this.running) return [];
    if (this.protectiveExitInProgress) return [];

    const symbols = [...this.portfolio.getMaterialPositionSymbols()];
    if (symbols.length === 0) return [];

    this.protectiveExitInProgress = true;
    try {
      const prices =
        opts.refreshPrices || symbols.some((s) => !this.buildPositionPrices().has(s))
          ? await this.fetchPricesForPositions(symbols)
          : this.buildPositionPrices();

      const exitSignals = this.buildProtectiveExitSignals(prices);
      if (exitSignals.length === 0) return [];

      logger.risk("Protective exit check firing sells", {
        symbols: exitSignals.map((s) => s.symbol),
        reasons: exitSignals.map((s) => s.reasons[0]),
      });
      brainProtectiveExit(
        exitSignals.map((s) => s.symbol),
        exitSignals.map((s) => s.reasons[0] ?? "stop/TP")
      );

      const results: import("./utils/types.js").TradeResult[] = [];
      for (const signal of exitSignals) {
        const result = await this.executeTrade(signal, {
          protectiveExit: true,
          sellAll: true,
        });
        if (result?.success) results.push(result);
      }

      if (results.length > 0 && this.config.mode === "live") {
        try {
          await this.reconcileLivePortfolio(prices);
        } catch (err) {
          logger.warn("Post-exit wallet sync failed", { error: String(err) });
        }
      }
      return results;
    } catch (err) {
      logger.warn("Protective exit check failed", { error: String(err) });
      return [];
    } finally {
      this.protectiveExitInProgress = false;
    }
  }

  /**
   * Fetch quotes, Binance OHLCV/logos/live prices, and recompute signals.
   * Light pulses reuse the last universe and overlay live Binance prices.
   */
  private async runMarketSignalRefresh(opts: {
    fullScan?: boolean;
    force?: boolean;
  } = {}): Promise<MarketData[]> {
    if (this.signalRefreshPromise) {
      if (!opts.force) return this.lastMarketData;
      while (this.signalRefreshPromise) {
        await this.signalRefreshPromise.catch(() => {});
      }
    }

    const work = this.doMarketSignalRefresh(opts);
    this.signalRefreshPromise = work;
    try {
      return await work;
    } finally {
      if (this.signalRefreshPromise === work) this.signalRefreshPromise = null;
    }
  }

  private async doMarketSignalRefresh(opts: {
    fullScan?: boolean;
    force?: boolean;
  }): Promise<MarketData[]> {
    this.signalRefreshInProgress = true;
    const started = Date.now();
    const fullScan = !!opts.fullScan || this.lastMarketData.length === 0;
    try {
      this.applySessionSizing();
      await this.fetchNewsIfStale();
      if (fullScan || this.cycleInProgress) {
        const cmc = await refreshCmcMacro();
        if (cmc) brainCmcMacro(cmc.summary, cmc.sizeScale, cmc.eventRisk);
      }
      const markets = fullScan
        ? await this.collectMarketData(true)
        : this.lastMarketData.map((m) => ({ ...m }));
      await this.applyBinanceEnrichment(markets, fullScan);
      const signals = this.runSignalAnalysis(markets);
      this.lastMarketData = markets;
      this.lastSignalRefreshAt = Date.now();
      if (fullScan) this.lastFullScanAt = Date.now();

      if (!this.cycleInProgress && fullScan) {
        brainSignalPulse(fullScan, markets.length, signals);
      }

      logger.info("Market signals refreshed", {
        tokens: markets.length,
        scored: this.lastSignals.size,
        fullScan,
        livePulse: !fullScan,
        durationMs: Date.now() - started,
      });
      return markets;
    } catch (err) {
      logger.warn("Market signal refresh failed", { error: String(err) });
      return this.lastMarketData;
    } finally {
      this.signalRefreshInProgress = false;
    }
  }

  private runSignalAnalysis(markets: MarketData[]): import("./utils/types.js").TradeSignal[] {
    const signals = analyzeMarkets(
      markets,
      this.config,
      this.lastNewsSentiment,
      getCmcMacro()
    );
    this.rememberSignals(signals);
    for (const md of markets) {
      if (!isTradableToken(md.symbol, md.price)) {
        this.lastSignals.delete(md.symbol);
        this.lastSignalConfidence.delete(md.symbol);
        this.lastTradeSignals.delete(md.symbol);
        continue;
      }
      if (!this.lastSignals.has(md.symbol)) {
        this.lastSignals.set(md.symbol, 0);
        this.lastSignalConfidence.set(md.symbol, 0.3);
      }
    }
    return signals;
  }

  private async applyBinanceEnrichment(markets: MarketData[], fullScan: boolean) {
    const enrichTargets = [
      ...new Set([
        ...markets.map((m) => m.symbol),
        ...this.watchlist,
        ...this.lastSignals.keys(),
        ...this.portfolio.getAllPositions().keys(),
        ...(fullScan ? listKnownBscTokenSymbols() : []),
      ]),
    ].filter((s) => {
      const md = markets.find((m) => m.symbol === s);
      return isTradableToken(s, md?.price ?? getLatestPrice(s));
    });

    const ohlcvSymbols = fullScan
      ? enrichTargets.filter((s) => knownBscAddress(s))
      : enrichTargets.filter(
          (s) =>
            knownBscAddress(s) &&
            (this.watchlist.includes(s) ||
              this.portfolio.getAllPositions().has(s))
        );

    const { liveQuotes, icons, ohlcvLoaded } = await enrichSymbolsFromBinance(
      enrichTargets,
      {
        fetchLive: true,
        fetchIcons: true,
        fetchOhlcv: true,
        ohlcvSymbols,
      }
    );

    for (const [symbol, icon] of icons) this.tokenIcons.set(symbol, icon);

    if (this._cachedWalletInfo?.binancePositions) {
      for (const p of this._cachedWalletInfo.binancePositions) {
        const icon = iconFromWalletRow(p.icon);
        if (icon) this.tokenIcons.set(p.symbol.toUpperCase(), icon);
      }
    }

    const marketBySymbol = new Map(markets.map((m) => [m.symbol, m]));

    for (const [symbol, quote] of liveQuotes) {
      const ref = marketBySymbol.get(symbol)?.price ?? getLatestPrice(symbol) ?? undefined;
      if (isPlausibleLivePrice(ref, quote.price)) {
        this.livePrices.set(symbol, quote);
      } else {
        this.livePrices.delete(symbol);
      }
    }

    for (const symbol of enrichTargets) {
      const sym = symbol.toUpperCase();
      if (this.tokenIcons.has(sym)) continue;
      const addr = knownBscAddress(sym);
      if (addr) this.tokenIcons.set(sym, trustWalletIconUrl(addr));
    }

    for (const md of markets) {
      this.mergeLiveQuoteIntoMarket(md, this.livePrices.get(md.symbol));
    }

    for (const [symbol, quote] of this.livePrices) {
      if (!marketBySymbol.has(symbol)) {
        markets.push(
          buildMarketData(symbol, quote.price, {
            change24h: quote.change24hPct,
            volume24h: quote.volume24h,
          })
        );
      }
    }

    for (const md of markets) {
      if (!hasRealHistory(md.symbol)) {
        seedPriceHistory(md.symbol, md.price, 50, 3.5);
      }
    }

    if (liveQuotes.size > 0 || ohlcvLoaded.length > 0) {
      logger.info("Binance Web3 enrichment applied", {
        targets: enrichTargets.length,
        liveQuotes: liveQuotes.size,
        icons: this.tokenIcons.size,
        ohlcvLoaded: ohlcvLoaded.length,
        fullScan,
      });
    }
  }

  private mergeLiveQuoteIntoMarket(
    md: MarketData,
    live: BinanceLiveQuote | undefined
  ) {
    const ref = md.price > 0 ? md.price : undefined;
    if (live && live.price > 0 && isPlausibleLivePrice(ref, live.price)) {
      md.price = live.price;
      if (Number.isFinite(live.change24hPct)) md.change24h = live.change24hPct;
      recordPrice(md.symbol, live.price, live.volume24h || md.volume24h);
    } else {
      recordPrice(md.symbol, md.price, md.volume24h);
    }
  }

  private async collectMarketData(fullScan: boolean): Promise<MarketData[]> {
    const markets: MarketData[] = [];
    let trendingTokens: Array<{ symbol: string }> | null = null;

    const tokensToCheck = new Set([
      ...this.watchlist,
      ...this.portfolio.getAllPositions().keys(),
    ]);
    const symbols = [...tokensToCheck];

    // Tier 2: full eligible-token scan when requested.
    if (fullScan) {
      await this.runFullTokenScan(markets);
    }

    // Primary: CMC Agent Hub quotes via x402 (batch = fewer micropayments)
    const cmcQuotes = await this.fetchCmcQuotes(symbols);
    for (const md of cmcQuotes.values()) {
      markets.push(md);
    }

    // Fallback: Agentic Wallet / Binance spot for symbols CMC did not return
    for (const symbol of symbols) {
      if (cmcQuotes.has(symbol)) continue;
      try {
        const priceData = await this.mcp.getTokenPrice(BSC_CHAIN, symbol);
        if (priceData) {
          if (!hasRealHistory(symbol) && getHistoryLength(symbol) < 40) {
            seedPriceHistory(symbol, priceData.price, 50, 3.5);
          }
          markets.push(buildMarketData(symbol, priceData.price));
        }
      } catch (err) {
        logger.warn(`Price fallback failed for ${symbol}`, { error: String(err) });
      }
    }

    // Trending: eligible bStock list / CMC, then wallet fallback
    try {
      const raw = await this.mcp.x402Request(CMC_ENDPOINTS.trending(), this.x402Payment);
      trendingTokens = parseCmcTrending(unwrapX402Response(raw));
      if (trendingTokens?.length) {
        logger.info("CMC trending tokens (x402)", { count: trendingTokens.length });
      }
    } catch (err) {
      logger.warn("CMC trending x402 failed", { error: String(err) });
    }

    if (!trendingTokens) {
      try {
        trendingTokens = await this.mcp.getTrendingTokens(20);
      } catch {
        // supplementary
      }
    }

    if (trendingTokens) {
      const newSymbols = trendingTokens
        .filter((t) => isTradableToken(t.symbol, getLatestPrice(t.symbol)) && !tokensToCheck.has(t.symbol))
        .map((t) => t.symbol);

      const trendingQuotes = await this.fetchCmcQuotes(newSymbols);
      for (const md of trendingQuotes.values()) {
        markets.push(md);
      }

      for (const symbol of newSymbols) {
        if (trendingQuotes.has(symbol)) continue;
        try {
          const priceData = await this.mcp.getTokenPrice(BSC_CHAIN, symbol);
          if (priceData) {
            if (!hasRealHistory(symbol) && getHistoryLength(symbol) < 40) {
              seedPriceHistory(symbol, priceData.price, 50, 4);
            }
            markets.push(buildMarketData(symbol, priceData.price));
          }
        } catch {
          // skip
        }
      }
    }

    this.rotateWatchlist(trendingTokens, markets);

    logger.info("Market data fetched", {
      count: markets.length,
      watchlist: this.watchlist.length,
      cmcQuotes: cmcQuotes.size,
      bridge: this.bridgeSource,
      dataSource: "cmc-agent-hub-x402",
      fullScanCycle: fullScan,
    });
    return markets;
  }

  /** @deprecated Use collectMarketData via runMarketSignalRefresh */
  private async fetchMarketData(): Promise<MarketData[]> {
    const fullScan =
      this.cycleCount <= 1 || this.cycleCount % FULL_SCAN_INTERVAL === 0;
    return this.collectMarketData(fullScan);
  }

  /**
   * Tier 2 scan: quote all eligible tokens in batches, record prices,
   * promote top movers into the active watchlist.
   */
  private async runFullTokenScan(existingMarkets: MarketData[]) {
    const tradable = ELIGIBLE_TOKENS.filter((s) => isTradableToken(s));
    const already = new Set(existingMarkets.map((m) => m.symbol));
    const allQuotes = new Map<string, MarketData>();

    logger.info("Full token scan starting", {
      eligible: tradable.length,
      batchSize: FULL_SCAN_BATCH_SIZE,
    });

    for (let i = 0; i < tradable.length; i += FULL_SCAN_BATCH_SIZE) {
      const batch = tradable.slice(i, i + FULL_SCAN_BATCH_SIZE);
      const quotes = await this.fetchCmcQuotes(batch);
      for (const [symbol, md] of quotes) {
        if (!isTradableToken(symbol, md.price)) continue;
        allQuotes.set(symbol, md);
        if (!already.has(symbol)) {
          existingMarkets.push(md);
          already.add(symbol);
        }
      }
    }

    // Promote top movers by 24h change + news sentiment boost
    const ranked = [...allQuotes.entries()]
      .map(([symbol, md]) => {
        const newsBoost = this.lastNewsSentiment.get(symbol)?.score ?? 0;
        const change = md.change24h ?? 0;
        const rankScore = Math.abs(change) + Math.abs(newsBoost) * 0.3;
        return { symbol, change, rankScore };
      })
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, FULL_SCAN_PROMOTE_COUNT);

    if (ranked.length > 0) {
      const promoted = ranked.map((r) => r.symbol);
      for (const symbol of promoted) {
        this.watchlist = [...new Set([...this.watchlist, symbol])];
      }
      logger.info("Full scan promoted breakout tokens", {
        promoted,
        topChange: ranked[0]?.change,
      });
    }
  }

  /** Fetch CMC quotes via x402 in batches of 20 symbols. */
  private async fetchCmcQuotes(symbols: string[]): Promise<Map<string, MarketData>> {
    const out = new Map<string, MarketData>();
    if (symbols.length === 0) return out;

    const batchSize = 20;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      try {
        const raw = await this.mcp.x402Request(
          CMC_ENDPOINTS.quotes(batch),
          this.x402Payment
        );
        const body = unwrapX402Response(raw);
        const parsed = parseCmcQuotesBatch(body, batch);
        for (const [symbol, md] of parsed) {
          out.set(symbol, md);
        }
      } catch (err) {
        logger.warn("CMC x402 batch quote failed", { batch: batch.join(","), error: String(err) });
      }
    }

    const missing = symbols.filter((s) => !out.has(s));
    if (missing.length > 0) {
      try {
        const enrich = await enrichSymbolsFromBinance(missing, {
          fetchLive: true,
          fetchIcons: false,
          fetchOhlcv: true,
        });
        for (const [symbol, q] of enrich.liveQuotes) {
          if (q.price <= 0) continue;
          out.set(symbol, {
            symbol,
            price: q.price,
            change24h: q.change24hPct,
            volume24h: q.volume24h,
            timestamp: q.updatedAt,
          });
        }
      } catch (err) {
        logger.warn("Binance bStock quote fallback failed", { error: String(err) });
      }
    }
    return out;
  }

  /**
   * Merge trending + volatile pool into watchlist; cap at MAX_WATCHLIST_SIZE.
   * Never drop open positions.
   */
  private rotateWatchlist(
    trending: Array<{ symbol: string }> | null,
    markets: MarketData[]
  ) {
    const positions = new Set(this.portfolio.getAllPositions().keys());
    const next = new Set<string>([
      ...MOMENTUM_CORE.filter((s) => isTradableToken(s)),
      ...ANCHOR_TOKENS.filter((s) => isTradableToken(s)),
      ...positions,
      ...this.watchlist.filter((s) => isTradableToken(s, getLatestPrice(s))),
    ]);

    if (trending) {
      for (const t of trending) {
        if (isTradableToken(t.symbol, getLatestPrice(t.symbol))) next.add(t.symbol);
      }
    }

    for (const m of markets) {
      if (MOMENTUM_VOLATILE.includes(m.symbol) && isTradableToken(m.symbol, m.price)) {
        next.add(m.symbol);
      }
    }

    if (next.size > MAX_WATCHLIST_SIZE) {
      const droppable = [...next]
        .filter((s) => !positions.has(s) && !MOMENTUM_CORE.includes(s))
        .map((symbol) => ({
          symbol,
          absMom: Math.abs(getTokenMomentumMetrics(symbol).momentum ?? 0),
        }))
        .sort((a, b) => a.absMom - b.absMom);

      for (const { symbol } of droppable) {
        if (next.size <= MAX_WATCHLIST_SIZE) break;
        next.delete(symbol);
      }
    }

    this.watchlist = [...next];
  }

  private rememberSignals(signals: import("./utils/types.js").TradeSignal[]) {
    for (const s of signals) {
      this.lastSignals.set(s.symbol, s.score);
      this.lastSignalConfidence.set(s.symbol, s.confidence);
      this.lastTradeSignals.set(s.symbol, s);
    }
  }

  private applySessionSizing() {
    const clock = getSessionClock(this.config.sessionPolicy);
    const profile = getSessionProfile(clock.active);
    this.config.positionSizeMultiplier = profile.positionSizeMultiplier;
  }

  getSessionClock(): SessionClock {
    return getSessionClock(this.config.sessionPolicy);
  }

  private async fetchNewsIfStale(): Promise<Map<string, NewsSentiment>> {
    if (
      this.lastNewsSentiment.size > 0 &&
      Date.now() - this.lastNewsFetchedAt < NEWS_REFRESH_MS
    ) {
      return this.lastNewsSentiment;
    }
    const sentiment = await this.fetchNews();
    this.lastNewsFetchedAt = Date.now();
    return sentiment;
  }

  /** Fetch ClipX news and compute per-token sentiment map. */
  private async fetchNews(): Promise<Map<string, NewsSentiment>> {
    try {
      const articles = await fetchNewsFeed(30);
      this.lastNewsCount = articles.length;

      // Scan all eligible tokens — not just active watchlist
      const sentiment = analyzeNewsSentiment(articles);
      this.lastNewsSentiment = sentiment;
      return sentiment;
    } catch (err) {
      logger.warn("News fetch failed — using last known sentiment", {
        error: String(err),
      });
      return this.lastNewsSentiment;
    }
  }

  private isInFailedSwapCooldown(symbol: string): boolean {
    const until = this.failedSwapUntil.get(symbol.toUpperCase()) ?? 0;
    return until > Date.now();
  }

  private markFailedSwap(symbol: string) {
    this.failedSwapUntil.set(
      symbol.toUpperCase(),
      Date.now() + this.config.failedSwapCooldownMs
    );
  }

  private async executeTrade(
    signal: import("./utils/types.js").TradeSignal,
    opts: {
      manual?: boolean;
      order?: import("./utils/types.js").TradeOrder;
      /** Sell entire on-chain balance (not a partial $-denominated slice). */
      sellAll?: boolean;
      amountUsd?: number;
      /** SL/TP/trailing. */
      protectiveExit?: boolean;
    } = {}
  ): Promise<TradeResult | null> {
    if (!opts.manual && this.isInFailedSwapCooldown(signal.symbol)) {
      const until = this.failedSwapUntil.get(signal.symbol.toUpperCase()) ?? 0;
      logger.info("Trade skipped — recent failed swap cooldown", {
        symbol: signal.symbol,
        remainingMin: Math.ceil((until - Date.now()) / 60000),
      });
      return null;
    }

    if (opts.protectiveExit && signal.action === "sell") {
      const pos = this.portfolio.getPosition(signal.symbol);
      const entry = pos?.avgEntryPrice ?? 0;
      if (!(entry > 0) || !Number.isFinite(entry)) {
        logger.risk("Protective sell blocked — missing entry price", {
          symbol: signal.symbol,
        });
        return null;
      }
    }

    let order: import("./utils/types.js").TradeOrder;
    if (opts.order) {
      order = opts.order;
    } else {
      const validation = validateAndCreateOrder(signal, this.riskManager, this.config, opts);
      if (!validation.approved || !validation.order) {
        logger.info("Trade not approved", {
          symbol: signal.symbol,
          reasons: validation.violations,
        });
        if (!opts.manual) {
          brainTradeSkipped(
            signal.symbol,
            signal.action,
            validation.violations?.[0] ?? "did not pass risk checks"
          );
        }
        return null;
      }
      order = validation.order;
    }

    if (this.config.mode === "paper") {
      logger.trade("PAPER trade executed", {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        amountUsd: order.amountUsd,
      });

      const price = getLatestPrice(order.symbol) || 0;
      const result: TradeResult = {
        orderId: order.id,
        success: true,
        txHash: `paper-${Date.now()}`,
        fromToken: order.fromToken,
        toToken: order.toToken,
        fromAmount: String(order.amountUsd),
        toAmount: price > 0 ? String(order.amountUsd / price) : "0",
        priceAtExecution: price,
        timestamp: Date.now(),
      };

      applyTradeToPortfolio(order, result, this.portfolio);
      await this.persistTrade(order, result);
      brainTradeExecuted(order.side, order.symbol, order.amountUsd, result.txHash);
      return result;
    }

    // Live mode: get quote first, then execute
    try {
      // For sells, use the wallet's actual transferable balance. Partial sells
      // only when the operator specifies an explicit USD amount.
      if (order.side === "sell") {
        const onChainBalance = await this.getOnChainTokenBalance(order.fromToken);
        const tracked = order.fromTokenAmount ?? 0;

        if (onChainBalance === null || onChainBalance <= 0) {
          return this.sellBlockedResult(
            order,
            `Wallet balance for ${order.symbol} not confirmed on-chain` +
              (tracked > 0 ? ` (bookkeeping shows ${tracked.toFixed(4)})` : "") +
              " — run dashboard resync or verify on Binance Web3"
          );
        }

        const partialUsd =
          opts.amountUsd !== undefined && opts.amountUsd > 0;
        const sellAll = !partialUsd || opts.sellAll === true;
        const sellable = sellAll
          ? onChainBalance
          : Math.min(tracked > 0 ? tracked : onChainBalance, onChainBalance);
        const safeAmount = sellAll
          ? floorTokenAmount(sellable, 8)
          : floorTokenAmount(sellable * 0.999, 8);

        if (safeAmount <= 0) {
          return this.sellBlockedResult(
            order,
            `Verified ${order.symbol} balance is too small to sell (${onChainBalance})`
          );
        }

        if (tracked > 0 && Math.abs(tracked - onChainBalance) / onChainBalance > 0.05) {
          logger.warn("Sell amount adjusted — bookkeeping differs from wallet", {
            symbol: order.symbol,
            trackedAmount: tracked,
            onChainBalance,
            sellAmount: safeAmount,
          });
        }

        logger.info("Reconciled sell amount to verified wallet balance", {
          symbol: order.symbol,
          sellAll,
          trackedAmount: tracked,
          onChainBalance,
          sellAmount: safeAmount,
        });
        order.fromTokenAmount = safeAmount;
      }

      const quoteParams = buildQuoteParams(order);
      const quote = await this.mcp.getSwapQuote(quoteParams);

      if (!quote) {
        logger.warn("No quote available", { symbol: order.symbol });
        return null;
      }

      // Check token risk before execution
      const risk = await this.mcp.checkTokenRisk(BSC_CHAIN, order.toToken);
      if (risk && (risk as Record<string, boolean>).isHoneypot) {
        logger.risk("HONEYPOT DETECTED — aborting trade", { token: order.toToken });
        return null;
      }

      const swapParams = buildSwapParams(order);
      const swapResult = await this.mcp.executeSwap(swapParams);

      logger.info("Agentic Wallet swap raw response", {
        symbol: order.symbol,
        side: order.side,
        keys: Object.keys(swapResult),
        sample: JSON.stringify(swapResult).slice(0, 500),
      });

      const price = getLatestPrice(order.symbol) || 0;
      const result = processSwapResult(order, swapResult, price, { requireOnChainTx: true });

      await this.persistTrade(order, result, swapResult);

      if (result.success) {
        applyTradeToPortfolio(order, result, this.portfolio);
        brainTradeExecuted(order.side, order.symbol, order.amountUsd, result.txHash);
        try {
          await this.syncWalletCapital();
        } catch (err) {
          logger.warn("Post-trade wallet sync failed", { error: String(err) });
        }
        if (opts.manual) {
          this.scheduleTradeHistoryBackfill([], { force: true });
        }
      } else {
        logger.warn("Live swap not confirmed on-chain — portfolio unchanged", {
          orderId: order.id,
          symbol: order.symbol,
          error: result.error,
        });
        brainTradeFailed(order.symbol, result.error ?? "swap not confirmed on-chain");
        if (!opts.manual) this.markFailedSwap(order.symbol);
      }

      return result;
    } catch (err) {
      if (!opts.manual) this.markFailedSwap(signal.symbol);
      const msg = String(err);
      logger.error("Trade execution error", {
        orderId: order.id,
        symbol: order.symbol,
        error: msg,
      });
      brainTradeFailed(order.symbol, msg);
      return null;
    }
  }

  getPortfolio(): PortfolioTracker {
    return this.portfolio;
  }

  /**
   * Dashboard / command assistant — run a manual trade with structured errors.
   */
  /**
   * Make a token tradable on demand for assistant/manual commands, even if it
   * isn't on the active watchlist. Resolves the bStock contract (type=3) and
   * fetches a live price (Binance Web3 → CMC fallback),
   * seeding price history so sizing/execution have real numbers.
   *
   * Returns whether the token can now be routed (has a contract + price).
   */
  async primeTokenForTrade(symbol: string): Promise<{ routable: boolean; price: number | null; address?: string }> {
    const sym = symbol.toUpperCase();

    // 1. Resolve a BSC contract address (static map, else CMC — populates cache).
    let address: string | undefined;
    try {
      address = (await resolveBscTokenAddress(sym)) ?? undefined;
    } catch (err) {
      logger.warn("Manual-trade address resolve failed", { symbol: sym, error: String(err) });
    }

    // 2. Ensure we have a price + enough history for indicators/sizing.
    if (getLatestPrice(sym) === null || getHistoryLength(sym) < 20) {
      try {
        const quotes = await this.fetchCmcQuotes([sym]);
        const md = quotes.get(sym);
        if (md && md.price > 0 && getHistoryLength(sym) < 40) {
          seedPriceHistory(sym, md.price, 50, 3.5);
        }
      } catch (err) {
        logger.warn("Manual-trade CMC prime failed", { symbol: sym, error: String(err) });
      }
    }

    if (getLatestPrice(sym) === null) {
      try {
        const priceData = await this.mcp.getTokenPrice(BSC_CHAIN, sym);
        if (priceData && priceData.price > 0) {
          seedPriceHistory(sym, priceData.price, 50, 3.5);
        }
      } catch (err) {
        logger.warn("Manual-trade wallet price prime failed", { symbol: sym, error: String(err) });
      }
    }

    const price = getLatestPrice(sym);
    const routable = hasBscSwapAddress(sym) && price !== null;
    logger.info("Primed token for manual trade", { symbol: sym, address: address ?? "unmapped", price, routable });
    return { routable, price, address };
  }

  async executeManualTrade(
    signal: import("./utils/types.js").TradeSignal,
    opts: { amountUsd?: number; sellAll?: boolean } = {}
  ): Promise<{
    result: TradeResult | null;
    violations?: string[];
    tradeSizeUsd: number;
  }> {
    const sellAll =
      opts.sellAll ??
      (signal.action === "sell" &&
        !(opts.amountUsd !== undefined && opts.amountUsd > 0));

    // Resolve contract + price up-front so any eligible token is tradable,
    // not just ones currently on the watchlist.
    await this.primeTokenForTrade(signal.symbol);

    if (sellAll) {
      await this.ensureTrackedPosition(signal.symbol);
    }

    // Manual = operator-initiated (assistant / NL command). Bypasses the
    // autonomous daily-trade pacing cap, but still respects hard safety
    // (eligibility, funds, drawdown, position size).
    const validation = validateAndCreateOrder(signal, this.riskManager, this.config, {
      manual: true,
      amountUsd: opts.amountUsd,
    });
    if (!validation.approved || !validation.order) {
      return {
        result: null,
        violations: validation.violations ?? ["Trade not approved"],
        tradeSizeUsd: validation.order?.amountUsd ?? opts.amountUsd ?? 0,
      };
    }
    const result = await this.executeTrade(signal, {
      manual: true,
      order: validation.order,
      sellAll,
      amountUsd: opts.amountUsd,
    });
    return { result, tradeSizeUsd: validation.order.amountUsd };
  }

  getRiskManager(): RiskManager {
    return this.riskManager;
  }

  getConfig(): AgentConfig {
    return { ...this.config };
  }

  updateWatchlist(tokens: string[]) {
    this.watchlist = tokens;
    logger.info("Watchlist updated", { tokens });
  }

  /**
   * Live-update agent config from dashboard controls.
   * Only allows safe fields — mode cannot be changed at runtime.
   */
  updateConfig(partial: Partial<AgentConfig> & { strategy?: string }) {
    const changed: Record<string, unknown> = {};

    const policyRaw = partial.sessionPolicy ?? (partial as { strategy?: string }).strategy;
    if (policyRaw !== undefined && isSessionPolicy(policyRaw)) {
      this.config.sessionPolicy = policyRaw;
      const clock = getSessionClock(policyRaw);
      const profile = getSessionProfile(clock.active);
      this.config.positionSizeMultiplier = profile.positionSizeMultiplier;
      if (partial.maxDrawdownPct === undefined) this.config.maxDrawdownPct = profile.risk.maxDrawdownPct;
      if (partial.maxPortfolioTokens === undefined) this.config.maxPortfolioTokens = profile.risk.maxPortfolioTokens;
      if (partial.minBuyConfidence === undefined) this.config.minBuyConfidence = profile.risk.minBuyConfidence;
      if (partial.stopLossPct === undefined) this.config.stopLossPct = profile.risk.stopLossPct;
      if (partial.takeProfitPct === undefined) this.config.takeProfitPct = profile.risk.takeProfitPct;
      if (partial.trailingActivatePct === undefined) this.config.trailingActivatePct = profile.risk.trailingActivatePct;
      if (partial.trailingGivebackPct === undefined) this.config.trailingGivebackPct = profile.risk.trailingGivebackPct;
      changed.sessionPolicy = policyRaw;
      changed.session = clock.active;
    }

    const safe: (keyof AgentConfig)[] = [
      "tradeIntervalMs", "maxPositionSizeUsd",
      "maxDrawdownPct", "slippageTolerance", "minGasReserveUsd", "maxPortfolioTokens",
      "minTradeAmountUsd", "minBuyConfidence", "stopLossPct", "takeProfitPct",
      "trailingActivatePct", "trailingGivebackPct", "autoExitEnabled",
      "protectiveExitCheckMs", "signalRefreshMs", "minBuyIntervalMs",
    ];
    for (const key of safe) {
      if (partial[key] !== undefined) {
        (this.config as unknown as Record<string, unknown>)[key] = partial[key];
        changed[key] = partial[key];
      }
    }
    if (partial.minGasReserveUsd !== undefined) {
      this.portfolio.setMinGasReserveUsd(Number(partial.minGasReserveUsd));
    }
    if (Object.keys(changed).length > 0) {
      logger.info("Config updated via dashboard", changed);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Full reset — clears portfolio, trade history, drawdown, PnL, and cycle
   * count. Re-syncs wallet from chain then resumes the trading loop. Called
   * when the operator hits the emergency restart button.
   */
  async restart() {
    this.running = false;

    const initialCash = parseFloat(process.env.INITIAL_CASH_USD || "10");
    this.portfolio = new PortfolioTracker(initialCash, this.config.mode === "live");
    this.cycleCount = 0;
    this.lastSignals.clear();
    this.lastNewsSentiment.clear();
    this.startedAt = Date.now();

    logger.info("Agent RESET — portfolio/PnL/drawdown cleared, restarting");

    // Re-seed from on-chain state so NAV is real.
    if (this.config.mode === "live") {
      try { await this.syncOnChainPositions(); } catch { /* ok */ }
      try { await this.syncWalletCapital(); } catch { /* ok */ }
    }

    // Re-enter the trading loop (non-blocking).
    this.start();
  }

  getCycleCount(): number {
    return this.cycleCount;
  }

  getWatchlist(): string[] {
    return [...this.watchlist];
  }

  async sellPosition(symbol: string): Promise<{
    result: TradeResult | null;
    violations?: string[];
    tradeSizeUsd: number;
    message: string;
  }> {
    const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!sym) {
      return { result: null, violations: ["Invalid symbol"], tradeSizeUsd: 0, message: "Invalid symbol" };
    }
    const tracked = await this.ensureTrackedPosition(sym);
    if (!tracked && !this.portfolio.getPosition(sym)) {
      return {
        result: null,
        violations: [`No position in ${sym}`],
        tradeSizeUsd: 0,
        message: `No position in ${sym} to sell`,
      };
    }
    const signal: import("./utils/types.js").TradeSignal = {
      symbol: sym,
      action: "sell",
      strength: "strong_sell",
      score: -80,
      reasons: ["Manual sell from dashboard"],
      targetAllocationPct: 0,
      confidence: 1,
    };
    const { result, violations, tradeSizeUsd } = await this.executeManualTrade(signal, {
      sellAll: true,
    });
    if (!result?.success) {
      return {
        result,
        violations,
        tradeSizeUsd,
        message: violations?.join("; ") || result?.error || `Failed to sell ${sym}`,
      };
    }
    return { result, tradeSizeUsd, message: `Sold ${sym}` };
  }

  /**
   * Resolve the real BSC wallet address.
   * Prefers the live Agentic Wallet address; falls back to AGENT_WALLET_ADDRESS env
   * when the bridge returns nothing or a known placeholder (mock/cmc-pro modes).
   */
  private resolveWalletAddress(mcpAddress?: string | null): string | null {
    const isPlaceholder = (a?: string | null) =>
      !!a && /^0x(0{40}|a{40})$/i.test(a);
    const envAddress = process.env.AGENT_WALLET_ADDRESS?.trim();
    if (mcpAddress && !isPlaceholder(mcpAddress)) return mcpAddress;
    if (envAddress) return envAddress;
    return mcpAddress ?? null;
  }

  /** Best-known address of the active wallet (cached MCP address → env). */
  private currentWalletAddress(): string | null {
    return this.resolveWalletAddress(this._cachedWalletInfo?.address ?? null);
  }

  /** Read Agentic Wallet address + on-chain balances for dashboard. */
  private _cachedWalletInfo: WalletInfo | null = null;
  private _walletInfoRefreshing = false;

  async getWalletInfo(): Promise<WalletInfo> {
    const addrResult = await this.mcp.getAddress(BSC_CHAIN);
    const address = this.resolveWalletAddress(addrResult?.address);

    let bnbBalance = 0;
    let usdtBalance = 0;

    if (address) {
      const bnb = await this.mcp.getWalletBalance(BSC_CHAIN);
      if (bnb?.balance) bnbBalance = parseFloat(bnb.balance) || 0;

      if (this.mcp.getStablecoinBalance) {
        const stable = await this.mcp.getStablecoinBalance(BSC_CHAIN);
        if (stable) usdtBalance = stable.balance;
      }
    }

    let walletMode = "local";
    let walletState = "unknown";
    let registered = false;
    let registrationOpen = false;
    let binancePositions: BinanceWeb3Position[] | undefined;

    if (address) {
      try {
        binancePositions = await fetchWalletPositions(address);
        if (binancePositions.length > 0) {
          const binanceUsdt = binancePositions.find((p) => p.symbol === "USDT");
          if (binanceUsdt && binanceUsdt.remainQty > 0) {
            usdtBalance = binanceUsdt.remainQty;
          }
          const binanceBnb = binancePositions.find((p) => p.symbol === "BNB");
          if (binanceBnb && binanceBnb.remainQty > 0) {
            bnbBalance = binanceBnb.remainQty;
          }
          for (const p of binancePositions) {
            const icon = iconFromWalletRow(p.icon);
            if (icon) this.tokenIcons.set(p.symbol.toUpperCase(), icon);
            if (p.price > 0) {
              this.livePrices.set(p.symbol.toUpperCase(), {
                price: p.price,
                change24hPct: p.percentChange24h,
                volume24h: 0,
                updatedAt: Date.now(),
              });
            }
          }
        }
      } catch (err) {
        logger.warn("Binance Web3 wallet query failed", { error: String(err) });
      }
    }

    if (this.mcp.getWalletStatus) {
      const status = await this.mcp.getWalletStatus();
      walletMode = String(status?.mode ?? status?.walletType ?? "local");
      walletState = String(status?.state ?? "unknown");
    }

    if (this.mcp.competitionStatus) {
      const comp = await this.mcp.competitionStatus();
      registered = Boolean(comp?.registered ?? comp?.isRegistered);
      registrationOpen = Boolean(comp?.registrationOpen ?? comp?.windowOpen);
    }
    const campaign = campaignQualification();
    registered = registered || campaign.registered;
    registrationOpen = campaign.active;

    const info: WalletInfo = {
      address,
      bnbBalance: Math.round(bnbBalance * 10000) / 10000,
      usdtBalance: Math.round(usdtBalance * 100) / 100,
      walletMode,
      walletState,
      registered,
      registrationOpen,
      campaign,
      ...(binancePositions && binancePositions.length > 0 ? { binancePositions } : {}),
    };
    this._cachedWalletInfo = info;
    return info;
  }

  /** Seed dashboard wallet cache from an on-chain sync (no MCP round-trips). */
  private primeWalletCache(address: string, binancePositions: BinanceWeb3Position[]) {
    const usdt = binancePositions.find((p) => p.symbol === "USDT");
    const bnb = binancePositions.find((p) => p.symbol === "BNB");
    const base = this._cachedWalletInfo ?? {
      address,
      bnbBalance: 0,
      usdtBalance: 0,
      walletMode: "local",
      walletState: "unknown",
      registered: false,
      registrationOpen: false,
    };
    this._cachedWalletInfo = {
      ...base,
      address,
      bnbBalance: bnb?.remainQty ?? base.bnbBalance,
      usdtBalance: usdt?.remainQty ?? base.usdtBalance,
      binancePositions,
    };
  }

  /** Non-blocking: returns cached wallet info, or fetches with a 8s timeout. */
  async getWalletInfoFast(): Promise<WalletInfo | null> {
    if (this._cachedWalletInfo) {
      if (!this._walletInfoRefreshing) {
        this._walletInfoRefreshing = true;
        this.getWalletInfo()
          .then((w) => { this._cachedWalletInfo = w; })
          .catch(() => {})
          .finally(() => { this._walletInfoRefreshing = false; });
      }
      return this._cachedWalletInfo;
    }
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000));
    const result = await Promise.race([this.getWalletInfo(), timeout]);
    return result;
  }

  /**
   * Live mode: align in-memory portfolio with on-chain reality.
   * On-chain holdings + USDT balance are the source of truth; unconfirmed
   * and phantom trades are purged from history (for accurate counts/display).
   */
  private async reconcileLivePortfolio(currentPrices?: Map<string, number>) {
    let heldSymbols = new Set<string>();
    let syncMeta = {
      added: [] as string[],
      removed: [] as string[],
      holdings: {} as Record<string, number>,
      rediscovered: 0,
    };
    try {
      const sync = await this.syncOnChainPositions();
      heldSymbols = sync.heldSymbols;
      syncMeta = {
        added: sync.added,
        removed: sync.removed,
        holdings: sync.holdings,
        rediscovered: sync.rediscovered,
      };
    } catch (err) {
      logger.warn("On-chain position sync during reconcile failed", { error: String(err) });
    }

    try {
      await this.syncWalletCapital();
    } catch (err) {
      logger.warn("Wallet sync during reconcile failed", { error: String(err) });
    }

    const removed = this.portfolio.purgeUnconfirmedTrades(isOnChainTxHash);
    if (removed > 0) {
      logger.warn("Purged unconfirmed trades from portfolio state", { removed });
    }

    const purged = this.portfolio.purgeTradesNotBackedByChain(
      heldSymbols,
      this.config.baseCurrency
    );
    if (purged > 0) {
      const nav = this.portfolio.estimateNavUsd(currentPrices);
      this.portfolio.recalibratePeakAfterPhantomPurge(nav, purged);
      logger.warn("Purged phantom trades not backed by on-chain holdings", { purged });
    }

    if (syncMeta.rediscovered > 0) {
      const nav = this.portfolio.estimateNavUsd(currentPrices);
      this.portfolio.recalibratePeakToOnChainNav(nav, syncMeta.rediscovered);
    } else if (
      this.portfolio.getAllPositions().size === 0 &&
      Object.keys(syncMeta.holdings).length === 0 &&
      this.portfolio.hasBaseline
    ) {
      const nav = this.portfolio.estimateNavUsd(currentPrices);
      if (this.portfolio.getPeakNav() > nav * 1.02) {
        this.portfolio.recalibratePeakToOnChainNav(nav, 1);
      }
      this.portfolio.realignNavBaselineIfStale(nav);
    }

    const store = getAgentStore();
    if (store.enabled) {
      const gas = this.portfolio.gasReserve;
      void store.saveChainSync({
        holdings: syncMeta.holdings,
        usdtBalance: this.portfolio.cash,
        positionsAdded: syncMeta.added,
        positionsRemoved: syncMeta.removed,
        ...(gas.valueUsd > 0 ? { gas } : {}),
      });
    }
    void store.savePositionEntries(this.portfolio.exportPositionEntries());

    if (syncMeta.removed.length > 0) {
      this.scheduleTradeHistoryBackfill([], { force: true });
    }

    this.scheduleTradeHistoryBackfill();
  }

  private async bootstrapPersistence() {
    const store = getAgentStore();
    let dbTrades: import("./utils/types.js").TradeResult[] = [];

    const entries = await store.loadPositionEntries();
    if (entries) this.portfolio.restorePersistedEntries(entries);

    if (store.enabled) {
      const navState = await store.loadNavState();
      if (navState) this.portfolio.restorePersistedNav(navState);

      const wallet = await this.resolveBootstrapWalletAddress();
      const bl = await store.loadUserBlacklist();
      restoreUserBlacklist(bl);

      dbTrades = await store.loadAllTradesForCostBasis(wallet);
      if (dbTrades.length > 0) {
        this.portfolio.hydrateTradeHistory(dbTrades);
        this.portfolio.rebuildPositionsFromTrades({ seedAmounts: true });
      }
    }

    this.scheduleTradeHistoryBackfill(dbTrades);
  }

  /** Run chain backfill without blocking startup (RPC scan can take 1–2 min). */
  private scheduleTradeHistoryBackfill(
    existing: import("./utils/types.js").TradeResult[] = [],
    opts: { force?: boolean } = {}
  ) {
    const minIntervalMs =
      parseInt(process.env.TRADE_HISTORY_BACKFILL_MS || "120000", 10) || 120000;
    if (
      !opts.force &&
      Date.now() - this.lastTradeHistoryBackfillAt < minIntervalMs
    ) {
      return;
    }

    if (this.tradeHistoryBackfillRunning) {
      this.tradeHistoryBackfillQueued = true;
      return;
    }

    void this.runTradeHistoryBackfill(existing).catch((err) => {
      logger.warn("Trade history backfill failed", { error: String(err) });
    });
  }

  private async runTradeHistoryBackfill(
    existing: import("./utils/types.js").TradeResult[] = []
  ) {
    this.tradeHistoryBackfillRunning = true;
    try {
      await this.backfillTradeHistoryFromChain(existing);
      this.lastTradeHistoryBackfillAt = Date.now();
    } finally {
      this.tradeHistoryBackfillRunning = false;
      if (this.tradeHistoryBackfillQueued) {
        this.tradeHistoryBackfillQueued = false;
        void this.runTradeHistoryBackfill([]).catch((err) => {
          logger.warn("Trade history backfill failed", { error: String(err) });
        });
      }
    }
  }

  /**
   * Import Recent Trades from Binance Web3 / BscScan when DB is empty or sparse.
   * Runs even without DATABASE_URL — does not depend on Neon.
   */
  private async backfillTradeHistoryFromChain(
    existing: import("./utils/types.js").TradeResult[] = []
  ) {
    if (this.config.mode !== "live") return;

    const wallet = await this.resolveBootstrapWalletAddress();
    if (!wallet) {
      logger.warn("Trade history backfill skipped — set AGENT_WALLET_ADDRESS or bind Agentic Wallet");
      return;
    }

    // Surface recent on-chain swaps quickly (e.g. both LINK sells) before the full scan.
    const recentTrades = await fetchRpcRecentTradeHistory(wallet, 50);
    if (recentTrades.length > 0) {
      await this.mergeNovelChainTrades(recentTrades, existing, wallet);
    }

    const chainTrades = await fetchWalletTradeHistory(wallet, 50);
    await this.mergeNovelChainTrades(chainTrades, existing, wallet);
  }

  private async mergeNovelChainTrades(
    chainTrades: import("./utils/types.js").TradeResult[],
    existing: import("./utils/types.js").TradeResult[],
    wallet: string
  ) {
    const realChainTrades = chainTrades.filter(
      (t) => t.txHash && /^0x[a-fA-F0-9]{64}$/.test(t.txHash)
    );

    if (realChainTrades.length > 0) {
      const purged = this.portfolio.purgeBinanceAggregateTrades();
      const store = getAgentStore();
      if (store.enabled) {
        const dbPurged = await store.deleteBinanceAggregateTrades(wallet);
        if (purged > 0 || dbPurged > 0) {
          logger.info("Replaced Binance aggregate trades with on-chain txs", {
            memory: purged,
            db: dbPurged,
          });
        }
      }
    }

    const knownHashes = new Set(
      existing.map((t) => t.txHash?.toLowerCase()).filter(Boolean) as string[]
    );
    for (const t of this.portfolio.getTradeHistory()) {
      if (t.txHash) knownHashes.add(t.txHash.toLowerCase());
    }

    const withHash = chainTrades.filter(
      (t) => t.txHash && /^0x[a-fA-F0-9]{64}$/.test(t.txHash)
    );
    const novel = withHash.filter(
      (t) => !knownHashes.has(t.txHash!.toLowerCase())
    );
    const refreshed = withHash.filter((t) =>
      knownHashes.has(t.txHash!.toLowerCase())
    );

    if (withHash.length === 0) {
      if (this.portfolio.getTradeHistory().length === 0 && chainTrades.length > 0) {
        this.portfolio.hydrateTradeHistory(chainTrades);
        this.portfolio.rebuildPositionsFromTrades({ seedAmounts: true });
        logger.info("Trade history hydrated from chain (memory only)", {
          count: chainTrades.length,
          wallet: wallet.slice(0, 10) + "…",
        });
      }
      return;
    }

    for (const t of refreshed) {
      this.portfolio.upsertChainTrade(t);
    }
    if (novel.length > 0) {
      this.portfolio.hydrateTradeHistory(novel);
    }

    const store = getAgentStore();
    if (store.enabled) {
      await Promise.all(withHash.map((t) => store.saveChainTrade(t, wallet)));
    }

    if (novel.length > 0 || refreshed.length > 0) {
      this.portfolio.rebuildPositionsFromTrades();
      logger.info("Trade history backfilled from chain", {
        imported: novel.length,
        refreshed: refreshed.length,
        wallet: wallet.slice(0, 10) + "…",
      });
    }
  }

  /** Wallet address for DB scoping before wallet cache is warm. */
  private async resolveBootstrapWalletAddress(): Promise<string | null> {
    const envAddr = this.resolveWalletAddress(process.env.AGENT_WALLET_ADDRESS);
    if (envAddr) return envAddr;
    try {
      const addr = await this.mcp.getAddress(BSC_CHAIN);
      return this.resolveWalletAddress(addr?.address);
    } catch {
      return null;
    }
  }

  private async persistTrade(
    order: TradeOrder,
    result: TradeResult,
    twakResponse?: Record<string, unknown> | null
  ) {
    const store = getAgentStore();
    if (store.enabled) {
      await store.saveTrade(order, result, this.config.mode, twakResponse, this.currentWalletAddress());
    }
    if (result.success) {
      this.portfolio.markTradePersisted(result.orderId);
      void store.savePositionEntries(this.portfolio.exportPositionEntries());
      if (store.enabled) {
        logger.trade(
          `Trade persisted to DB — ${order.side.toUpperCase()} ${order.symbol}`,
          {
            side: order.side,
            symbol: order.symbol,
            amountUsd: order.amountUsd,
            status: this.config.mode === "paper" ? "paper" : "confirmed",
            realizedPnl: result.realizedPnl,
          },
          result.txHash
        );
      }
    }
  }

  /** Compute key agent stats for persistence (win rate, trades, sentiment, etc.). */
  private computeCycleStats(snap: PortfolioSnapshot): import("./db/store.js").CycleStats {
    const closed = this.portfolio.getClosedTradeStats();

    return {
      realizedPnl: closed.realizedPnl,
      dailyPnl: snap.dailyPnl,
      positionsCount: snap.positions.length,
      totalTrades: this.portfolio.getTradeHistory().filter((t) => t.success).length,
      todayTrades: this.portfolio.getTodayTradeCount(),
      winRate: Math.round(closed.winRate * 10) / 10,
      fearGreed: null,
      emergencyMode: this.riskManager.isEmergencyMode(),
    };
  }

  private async persistCycleSnapshot(cycleId: number, snap: PortfolioSnapshot) {
    const store = getAgentStore();
    if (!store.enabled) return;
    const peak = this.portfolio.getPeakNav();
    await store.saveNavSnapshot(snap, cycleId, this.config.mode, peak, this.computeCycleStats(snap));
    await store.saveNavState({
      peakNavUsd: peak,
      initialNavUsd: this.portfolio.initialValue,
      baselineInitialized: this.portfolio.hasBaseline,
    });
  }

  /**
   * Force a full on-chain reconcile (positions + cash + chain sync) on demand.
   * Used by the dashboard "refresh" button. Returns the fresh state snapshot.
   */
  async forceResync(): Promise<AgentState> {
    if (this.config.mode === "live") {
      await this.reconcileLivePortfolio();
      await this.runTradeHistoryBackfill();
    } else {
      await this.syncWalletCapital().catch(() => undefined);
    }
    logger.info("Manual portfolio resync requested");
    return this.getStateSnapshot();
  }

  /**
   * Import a single held token into the portfolio without a full chain reconcile.
   * Used by manual sell commands so the assistant does not block on CLI wallet scans.
   */
  async ensureTrackedPosition(symbol: string): Promise<boolean> {
    const sym = symbol.toUpperCase();
    const existing = this.portfolio.getPosition(sym);
    if (existing && existing.amount > 0) return true;

    const onChain = await this.getOnChainTokenBalance(sym);
    if (onChain === null || onChain <= 0) return false;

    let price = getLatestPrice(sym) ?? undefined;
    if (!(price && price > 0)) {
      try {
        const quote = await this.mcp.getTokenPrice(BSC_CHAIN, sym);
        if (quote?.price && quote.price > 0) price = quote.price;
      } catch {
        /* best-effort pricing */
      }
    }
    if (!(price && price > 0)) return false;

    this.portfolio.reconcileOnChainPositions(
      new Map([[sym, onChain]]),
      new Map([[sym, price]])
    );
    logger.info("Position imported for manual trade", { symbol: sym, amount: onChain });
    return true;
  }

  /**
   * Rebuild tracked positions from the wallet's actual on-chain holdings so
   * NAV / allocation / PnL reflect every token held — including assets bought
   * outside this agent run. Eligible, non-stablecoin tokens only.
   */
  /**
   * Best-effort lookup of the wallet's actual transferable balance for a single
   * token. Agentic Wallet per-token → portfolio → Binance Web3 cache → live fetch.
   */
  private async getOnChainTokenBalance(symbol: string): Promise<number | null> {
    const sym = symbol.toUpperCase();

    if (this.mcp.getTokenBalance) {
      try {
        const bal = await this.mcp.getTokenBalance(BSC_CHAIN, sym);
        if (bal && typeof bal.amount === "number" && bal.amount > 0) {
          logger.info("Sell balance resolved via Agentic Wallet getTokenBalance", {
            symbol: sym,
            amount: bal.amount,
          });
          return bal.amount;
        }
      } catch (err) {
        logger.warn("getTokenBalance failed during sell reconcile", {
          symbol: sym,
          error: String(err),
        });
      }
    }

    if (this.mcp.getPortfolio) {
      try {
        const holdings = await this.mcp.getPortfolio(BSC_CHAIN);
        const match = holdings?.find((h) => h.symbol.toUpperCase() === sym);
        if (match && typeof match.amount === "number" && match.amount > 0) {
          logger.info("Sell balance resolved via Agentic Wallet getPortfolio", {
            symbol: sym,
            amount: match.amount,
          });
          return match.amount;
        }
      } catch (err) {
        logger.warn("getPortfolio lookup failed during sell reconcile", {
          symbol: sym,
          error: String(err),
        });
      }
    }

    const cached = this._cachedWalletInfo?.binancePositions?.find(
      (p) => p.symbol.toUpperCase() === sym
    );
    if (cached && cached.remainQty > 0) {
      logger.info("Sell balance resolved via Binance Web3 cache", {
        symbol: sym,
        amount: cached.remainQty,
      });
      return cached.remainQty;
    }

    const address = this.currentWalletAddress();
    if (address) {
      try {
        const positions = await fetchWalletPositions(address);
        if (positions.length > 0) {
          this.primeWalletCache(address, positions);
          const live = positions.find((p) => p.symbol.toUpperCase() === sym);
          if (live && live.remainQty > 0) {
            logger.info("Sell balance resolved via Binance Web3 live fetch", {
              symbol: sym,
              amount: live.remainQty,
            });
            return live.remainQty;
          }
        }
      } catch (err) {
        logger.warn("Binance Web3 balance lookup failed during sell", {
          symbol: sym,
          error: String(err),
        });
      }
    }

    return null;
  }

  private sellBlockedResult(
    order: import("./utils/types.js").TradeOrder,
    error: string
  ): import("./utils/types.js").TradeResult {
    logger.warn("Sell blocked — wallet balance not verified", {
      symbol: order.symbol,
      error,
      trackedAmount: order.fromTokenAmount,
    });
    brainTradeSkipped(order.symbol, "sell", error);
    return {
      orderId: order.id,
      success: false,
      fromToken: order.fromToken,
      toToken: order.toToken,
      fromAmount: "0",
      priceAtExecution: getLatestPrice(order.symbol) ?? 0,
      timestamp: Date.now(),
      error,
    };
  }

  private async syncOnChainPositions(): Promise<{
    heldSymbols: Set<string>;
    added: string[];
    removed: string[];
    holdings: Record<string, number>;
    rediscovered: number;
  }> {
    const empty = {
      heldSymbols: new Set<string>(),
      added: [] as string[],
      removed: [] as string[],
      holdings: {} as Record<string, number>,
      rediscovered: 0,
    };
    if (!this.mcp.getPortfolio) return empty;

    const holdings = await this.mcp.getPortfolio(BSC_CHAIN);
    if (!holdings) return empty;

    const amounts = new Map<string, number>();
    const prices = new Map<string, number>();
    const heldSymbols = new Set<string>();
    // On BSC only BNB is the native gas coin; ETH is a BEP-20 token (0x2170…)
    const NATIVE_GAS = new Set(["BNB"]);
    let nativeGasAmount = 0;

    const ingestHolding = async (h: PortfolioHolding) => {
      const symbol = h.symbol.toUpperCase();

      if (NATIVE_GAS.has(symbol)) {
        nativeGasAmount = h.amount;
        let valueUsd = h.valueUsd;
        if (!(valueUsd && valueUsd > 0) && h.amount > 0) {
          try {
            const quote = await this.mcp.getTokenPrice(BSC_CHAIN, symbol);
            if (quote?.price) valueUsd = h.amount * quote.price;
          } catch { /* use fiat from get_balance when available */ }
        }
        if (valueUsd && valueUsd > 0) {
          this.portfolio.setGasReserve(symbol, h.amount, valueUsd);
        }
        return;
      }

      if (!isEligibleToken(symbol) || isStablecoin(symbol)) return;
      if (!(h.amount > 0)) return;

      // Wallet balance APIs can echo native BNB for unrelated ERC-20 queries.
      if (nativeGasAmount > 0) {
        const rel = Math.abs(h.amount - nativeGasAmount) / nativeGasAmount;
        if (rel < 1e-6) return;
      }

      let derivedPrice = h.priceUsd
        ?? (h.valueUsd && h.amount > 0 ? h.valueUsd / h.amount : undefined)
        ?? getLatestPrice(symbol)
        ?? undefined;

      if (!(derivedPrice && derivedPrice > 0)) {
        try {
          const quote = await this.mcp.getTokenPrice(BSC_CHAIN, symbol);
          if (quote?.price && quote.price > 0) derivedPrice = quote.price;
        } catch {
          /* best-effort pricing */
        }
      }

      const valueUsd = h.valueUsd
        ?? (derivedPrice && h.amount > 0 ? derivedPrice * h.amount : 0);
      if (!(valueUsd >= MIN_POSITION_VALUE_USD)) return;

      amounts.set(symbol, h.amount);
      heldSymbols.add(symbol);

      if (derivedPrice && derivedPrice > 0) prices.set(symbol, derivedPrice);
    };

    // Resolve wallet address early — required for the token scan below.
    let walletAddress: string | undefined;
    try {
      const addr = await this.mcp.getAddress(BSC_CHAIN);
      walletAddress = this.resolveWalletAddress(addr?.address) ?? undefined;
    } catch (err) {
      walletAddress = process.env.AGENT_WALLET_ADDRESS?.trim() || undefined;
      logger.warn("Could not resolve wallet address for chain sync", {
        error: String(err),
        ...(walletAddress ? { fallback: "AGENT_WALLET_ADDRESS" } : {}),
      });
    }

    for (const h of holdings) {
      await ingestHolding(h);
    }

    if (walletAddress) {
      const bscTokens = await fetchBscTokenBalances(walletAddress);
      for (const h of bscTokens) {
        if (amounts.has(h.symbol.toUpperCase())) continue;
        await ingestHolding(h);
      }

      try {
        const binanceHoldings = await fetchBinanceWeb3Holdings(walletAddress);
        for (const h of binanceHoldings) {
          if (amounts.has(h.symbol.toUpperCase())) continue;
          await ingestHolding(h);
        }
        if (binanceHoldings.length > 0) {
          logger.info("Binance Web3 positions merged into sync", {
            tokens: binanceHoldings.map((h) => h.symbol),
          });
        }
        const binancePositions = await fetchWalletPositions(walletAddress);
        if (binancePositions.length > 0) {
          this.primeWalletCache(walletAddress, binancePositions);
        }
      } catch (err) {
        logger.warn("Binance Web3 sync failed", { error: String(err) });
      }
    }

    // Build probe list from actual trade history + DB — NOT the watchlist.
    const candidates = new Set<string>();
    for (const t of this.portfolio.getTradeHistory()) {
      if (!t.success) continue;
      const sym = t.toToken.toUpperCase();
      if (isEligibleToken(sym) && !isStablecoin(sym) && !NATIVE_GAS.has(sym)) {
        candidates.add(sym);
      }
    }
    for (const sym of this.portfolio.getAllPositions().keys()) {
      candidates.add(sym.toUpperCase());
    }

    const store = getAgentStore();
    if (store.enabled) {
      for (const sym of await store.loadTradedSymbols(this.currentWalletAddress())) {
        if (isEligibleToken(sym) && !isStablecoin(sym) && !NATIVE_GAS.has(sym)) {
          candidates.add(sym.toUpperCase());
        }
      }
      for (const sym of await store.loadLastChainSyncHoldings()) {
        if (isEligibleToken(sym) && !isStablecoin(sym) && !NATIVE_GAS.has(sym)) {
          candidates.add(sym.toUpperCase());
        }
      }
    }

    let rediscovered = 0;
    if (walletAddress) {
      logger.info("Starting CLI wallet scan", {
        wallet: `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`,
      });
      const scanned = await scanWalletViaCliSubprocess(walletAddress);
      logger.info("CLI wallet scan finished", { found: scanned.length });
      for (const h of scanned) {
        const sym = h.symbol.toUpperCase();
        if (amounts.has(sym)) continue;
        const wasTracked = this.portfolio.getPosition(sym) !== undefined;
        await ingestHolding(h);
        if (!wasTracked) rediscovered++;
        logger.info("Token balance recovered via wallet scan", {
          symbol: sym,
          amount: h.amount,
          valueUsd: h.valueUsd ? Math.round(h.valueUsd * 100) / 100 : undefined,
        });
      }
    }

    if (this.mcp.getTokenBalance) {
      for (const sym of candidates) {
        if (amounts.has(sym)) continue;
        try {
          const bal = await this.mcp.getTokenBalance(BSC_CHAIN, sym);
          if (bal && bal.amount > 0) {
            const wasTracked = this.portfolio.getPosition(sym) !== undefined;
            await ingestHolding(bal);
            if (!wasTracked) rediscovered++;
            logger.info("Token balance recovered via direct query", {
              symbol: sym,
              amount: bal.amount,
              valueUsd: bal.valueUsd ? Math.round(bal.valueUsd * 100) / 100 : undefined,
            });
          }
        } catch (err) {
          logger.warn("Direct token balance query failed", { symbol: sym, error: String(err) });
        }
      }

      // Verify positions before removal — don't drop a token unless balance is truly zero.
      for (const sym of [...this.portfolio.getAllPositions().keys()]) {
        if (amounts.has(sym)) continue;
        try {
          const bal = await this.mcp.getTokenBalance(BSC_CHAIN, sym);
          if (bal && bal.amount > 0) {
            await ingestHolding(bal);
            rediscovered++;
            logger.info("Position preserved after balance re-check", {
              symbol: sym,
              amount: bal.amount,
            });
          }
        } catch {
          /* removal stands if probe fails */
        }
      }
    }

    const { added, removed } = this.portfolio.reconcileOnChainPositions(amounts, prices);
    const gas = this.portfolio.gasReserve;
    if (added.length > 0 || removed.length > 0 || gas.valueUsd > 0 || rediscovered > 0) {
      logger.info("On-chain wallet synced", {
        ...(added.length > 0 ? { positionsAdded: added } : {}),
        ...(removed.length > 0 ? { positionsRemoved: removed } : {}),
        ...(rediscovered > 0 ? { rediscovered } : {}),
        tokenPositions: [...amounts.keys()],
        gas: gas.valueUsd > 0
          ? `${gas.amount.toFixed(4)} ${gas.symbol} (~$${gas.valueUsd.toFixed(2)})`
          : "none",
      });
    }

    return {
      heldSymbols,
      added,
      removed,
      holdings: Object.fromEntries(amounts),
      rediscovered,
    };
  }

  /** Sync portfolio cash from on-chain USDT balance (live trading). */
  async syncWalletCapital(): Promise<{ usdtBalance: number; synced: boolean }> {
    if (!this.mcp.getStablecoinBalance) {
      return { usdtBalance: this.portfolio.cash, synced: false };
    }

    const stable = await this.mcp.getStablecoinBalance(BSC_CHAIN);
    if (!stable) {
      logger.warn("Could not read USDT balance — Agentic Wallet not connected?");
      return { usdtBalance: this.portfolio.cash, synced: false };
    }

    this.portfolio.setCashUsd(stable.balance);

    const positionsValue = this.estimateTrackedPositionsValue();
    const navUsd =
      stable.balance + positionsValue + this.portfolio.gasReserve.valueUsd;

    if (this.portfolio.hasPendingNavRestore()) {
      this.portfolio.applyPendingNavRestore(navUsd);
    } else if (!this.portfolio.hasBaseline) {
      this.portfolio.setBaselineNav(navUsd);
    } else {
      this.portfolio.realignNavBaselineIfStale(navUsd);
    }

    logger.info("Wallet capital synced from chain", {
      usdt: stable.balance,
      symbol: stable.symbol,
    });

    return { usdtBalance: stable.balance, synced: true };
  }

  /** Current USD value of positions tracked in memory (best-effort pricing). */
  private estimateTrackedPositionsValue(): number {
    let total = 0;
    for (const [symbol, pos] of this.portfolio.getAllPositions()) {
      const price = getLatestPrice(symbol) ?? pos.avgEntryPrice;
      total += pos.amount * price;
    }
    return total;
  }

  async registerCompetition(): Promise<Record<string, unknown>> {
    if (!this.mcp.competitionRegister) {
      throw new Error("Competition registration requires Binance Agentic Wallet (`baw`)");
    }
    const result = await this.mcp.competitionRegister();
    if (!result) throw new Error("Registration failed — bind the wallet on the campaign Join Now page");
    logger.info("Campaign registration recorded", result);
    return result;
  }

  async startWalletSignin(): Promise<Record<string, unknown>> {
    return startAgenticSignin();
  }

  async verifyWalletSignin(qrCodeId: string): Promise<Record<string, unknown>> {
    const result = await verifyAgenticSignin(qrCodeId);
    this._cachedWalletInfo = null;
    await this.getWalletInfo().catch(() => undefined);
    return result;
  }

  getCampaignStatus(): Record<string, unknown> {
    return campaignQualification();
  }

  async runCampaignAiTasks(opts: { cmc?: boolean; studio?: boolean; tickers?: string[] } = {}) {
    const out: Record<string, unknown> = {};
    if (opts.cmc !== false) {
      const { text, record } = await completeCmcCampaignCall("get_global_metrics_latest");
      out.cmc = { tool: record.tool, preview: text.slice(0, 1500) };
    }
    if (opts.studio !== false) {
      const tickers =
        opts.tickers && opts.tickers.length > 0
          ? opts.tickers
          : this.watchlist.slice(0, 3).map((s) => tickerFromBstock(s));
      const job = await submitStudioAnalysis(tickers);
      out.studio = job;
    }
    return { ...out, qualification: campaignQualification() };
  }

  async pollCampaignStudioJob(): Promise<Record<string, unknown> | null> {
    const job = loadCampaignState().lastStudioJob;
    if (!job) return null;
    return pollStudioJob(job.jobId, job.jobToken);
  }

  async switchWalletMode(mode: "local" | "walletconnect"): Promise<Record<string, unknown>> {
    if (!this.mcp.switchWalletMode) {
      throw new Error("Wallet status requires Binance Agentic Wallet (`baw`)");
    }
    const result = await this.mcp.switchWalletMode(mode);
    if (!result) throw new Error("Wallet status check failed");
    logger.info("Wallet status", { mode, ...result });
    return result;
  }

  /**
   * Structured autonomous-mode status for dashboard / API.
   */
  buildAutonomousStatus(): AutonomousStatus {
    const risk = this.riskManager.riskSummary();
    const tradesToday = this.portfolio.getTodayTradeCount();
    const tradesLast24h = this.portfolio.countSuccessfulTradesSince(
      Date.now() - 24 * 60 * 60 * 1000
    );
    const emergencyMode = this.riskManager.isEmergencyMode();
    const session = this.getSessionClock();

    const failedSwapCooldowns: AutonomousStatus["failedSwapCooldowns"] = [];
    for (const [symbol, until] of this.failedSwapUntil) {
      const remainingMs = until - Date.now();
      if (remainingMs > 0) {
        failedSwapCooldowns.push({
          symbol,
          remainingMin: Math.ceil(remainingMs / 60_000),
        });
      }
    }

    let nextCycleInSec: number | null = null;
    if (this.running && this.lastCycleCompletedAt > 0) {
      const elapsed = Date.now() - this.lastCycleCompletedAt;
      nextCycleInSec = Math.max(
        0,
        Math.ceil((this.config.tradeIntervalMs - elapsed) / 1000)
      );
    } else if (this.running && this.cycleInProgress) {
      nextCycleInSec = null;
    } else if (this.running) {
      nextCycleInSec = Math.ceil(this.config.tradeIntervalMs / 1000);
    }

    let phase: AutonomousStatus["phase"] = "idle";
    let blockReason: string | undefined;
    let headline: string;

    if (!this.running) {
      phase = "stopped";
      headline = "Engine stopped";
      blockReason = "Start the agent to resume 24/7 trading";
    } else if (this.cycleInProgress) {
      phase = "scanning";
      headline = `LIVE · cycle #${this.cycleCount} · ${session.label}`;
    } else if (this.signalRefreshInProgress) {
      phase = "scanning";
      headline = `LIVE · pulsing ${session.label}`;
    } else if (emergencyMode) {
      phase = "blocked";
      headline = "Drawdown halt — new buys paused";
      blockReason = `Drawdown ${Math.round(risk.drawdownPct as number)}% (limit ${this.config.maxDrawdownPct}%)`;
    } else if (
      (risk.positionCount as number) >= (risk.maxPositions as number) &&
      (risk.positionCount as number) > 0
    ) {
      phase = "idle";
      headline = "LIVE · slots full — watching exits";
      blockReason = `${risk.positionCount}/${risk.maxPositions} positions`;
    } else {
      const lastBuyAt = this.portfolio.lastSuccessfulBuyAt();
      const interval = this.config.minBuyIntervalMs ?? 600_000;
      const waitLeft = lastBuyAt > 0 ? interval - (Date.now() - lastBuyAt) : 0;
      if (waitLeft > 0) {
        const waitMin = Math.max(1, Math.ceil(waitLeft / 60_000));
        phase = "idle";
        headline = `LIVE · next buy in ~${waitMin}m`;
        blockReason = `Entry pacing ${waitMin}m`;
      } else {
        phase = "idle";
        headline = `LIVE · ${session.label}`;
      }
    }

    const ready = this.running && !emergencyMode;

    return {
      phase,
      ready,
      headline,
      blockReason,
      tradesToday,
      tradesLast24h,
      emergencyMode,
      nextCycleInSec,
      lastCycleAt: this.lastCycleCompletedAt || null,
      lastCycleDurationSec: this.lastCycleDurationMs
        ? Math.round(this.lastCycleDurationMs / 1000)
        : null,
      lastCycleTrades: this.lastCycleTradesExecuted,
      lastCycleQueued: this.lastCycleSignalsQueued,
      tradeIntervalSec: Math.round(this.config.tradeIntervalMs / 1000),
      autoExitEnabled: this.config.autoExitEnabled,
      sessionPolicy: this.config.sessionPolicy,
      session: session.active,
      sessionLabel: session.label,
      nyTimeLabel: session.nyTimeLabel,
      failedSwapCooldowns,
    };
  }

  /**
   * Full agent state snapshot for dashboard / API consumers.
   */
  getStateSnapshot(): AgentState {
    const now = Date.now();
    if (this.stateCache && now - this.stateCache.at < 750) {
      return this.stateCache.value;
    }
    const value = this.buildStateSnapshot();
    this.stateCache = { at: now, value };
    return value;
  }

  private buildStateSnapshot(): AgentState {
    // Report the full set of analyzed tokens (watchlist + every token scored in
    // the last cycle, including full-scan promotions), not just the
    // 15-token trading watchlist — so the dashboard can show all of them.
    const held = new Set(this.portfolio.getAllPositions().keys());
    const userBlacklisted = getUserBlacklistedTokens();
    const scanSymbols = new Set<string>([
      ...this.watchlist,
      ...this.lastSignals.keys(),
      ...held,
      ...userBlacklisted,
    ]);

    const currentPrices = new Map<string, number>();
    for (const symbol of scanSymbols) {
      const price = getLatestPrice(symbol);
      if (price !== null) currentPrices.set(symbol, price);
    }
    for (const md of this.lastMarketData) {
      if (md.price > 0) currentPrices.set(md.symbol, md.price);
    }

    const reportSymbols = [
      ...new Set([
        ...[...scanSymbols].filter((s) =>
          isTradableToken(s, currentPrices.get(s))
        ),
        ...userBlacklisted,
      ]),
    ];
    const reportSet = new Set(reportSymbols);

    const portfolioSnap = this.portfolio.peekSnapshot(currentPrices, {
      stopLossPct: this.config.stopLossPct,
      takeProfitPct: this.config.takeProfitPct,
      trailingActivatePct: this.config.trailingActivatePct,
    });
    const snapshots = this.portfolio.getChartPoints();

    const tokenMetrics: Record<string, {
      momentum: number | null;
      atrPct: number | null;
      volumeRatio: number | null;
      score: number | null;
      newsScore: number | null;
      newsArticles: number;
      confidence?: number | null;
      rsi: number | null;
      macd: number | null;
      bbPosition: number | null;
      vwapDev: number | null;
      stochRsi?: number | null;
      gapPct?: number | null;
      orbBreakoutPct?: number | null;
      session?: string;
      regime?: string;
      ohlcvReal?: boolean;
      aiSummary?: string;
      aiVerdict?: string;
      aiAgrees?: boolean;
    }> = {};
    for (const symbol of reportSymbols) {
      const { momentum, atrPct, volumeRatio } = getTokenMomentumMetrics(symbol);
      const sig = this.lastSignals.get(symbol);
      const stored = this.lastTradeSignals.get(symbol);
      const news = this.lastNewsSentiment.get(symbol);
      const display = getTokenDisplayMetrics(symbol, currentPrices.get(symbol));
      const ai = this.lastAiInsights.get(symbol.toUpperCase());
      const summary = ai?.summary
        ? ai.summary.length > 180
          ? `${ai.summary.slice(0, 177)}...`
          : ai.summary
        : undefined;
      tokenMetrics[symbol] = {
        momentum,
        atrPct: stored?.atrPct ?? atrPct,
        volumeRatio: volumeRatio !== null ? Math.round(volumeRatio * 100) / 100 : null,
        score: sig !== undefined ? Math.round(sig) : null,
        confidence: this.lastSignalConfidence.get(symbol) ?? null,
        newsScore: news?.score ?? null,
        newsArticles: news?.articles ?? 0,
        rsi: display.rsi,
        macd: display.macdPct !== null ? Math.round(display.macdPct * 100) / 100 : null,
        bbPosition:
          display.bbPosition !== null ? Math.round(display.bbPosition * 10) / 10 : null,
        vwapDev: stored?.vwapDev ?? (display.vwapDev !== null ? Math.round(display.vwapDev * 100) / 100 : null),
        stochRsi: stored?.stochRsi ?? display.stochRsi,
        gapPct: stored?.gapPct ?? display.gapPct,
        orbBreakoutPct: stored?.orbBreakoutPct ?? display.orbBreakoutPct,
        session: stored?.session,
        regime: stored?.regime,
        ohlcvReal: hasRealHistory(symbol),
        ...(summary
          ? {
              aiSummary: summary,
              aiVerdict: ai!.verdict,
              aiAgrees: ai!.agreesWithSignal,
            }
          : {}),
      };
    }

    const session = this.getSessionClock();
    const prices: Record<string, number> = {};
    for (const symbol of reportSymbols) {
      const p = currentPrices.get(symbol);
      if (p != null) prices[symbol] = p;
    }

    const tokenIcons: Record<string, string> = {};
    for (const symbol of reportSymbols) {
      const url = this.tokenIcons.get(symbol);
      if (url) tokenIcons[symbol] = normalizeBinanceIcon(url) ?? url;
    }

    const livePrices: Record<string, { price: number; change24hPct: number; updatedAt: number }> = {};
    for (const [sym, q] of this.livePrices) {
      if (!reportSet.has(sym)) continue;
      livePrices[sym] = {
        price: q.price,
        change24hPct: q.change24hPct,
        updatedAt: q.updatedAt,
      };
    }

    const value: AgentState = {
      mode: this.config.mode,
      running: this.running,
      cycleCount: this.cycleCount,
      config: {
        ...this.config,
        minTradablePriceUsd: MIN_TRADABLE_PRICE_USD,
        excludedTokens: [...EXCLUDED_TOKENS],
      },
      portfolio: portfolioSnap,
      snapshots,
      trades: this.portfolio.getTradeHistory(),
      risk: this.riskManager.riskSummary(),
      watchlist: reportSymbols,
      prices,
      bridgeSource: this.bridgeSource,
      tokenMetrics,
      newsCount: this.lastNewsCount,
      lastSignalRefreshAt: this.lastSignalRefreshAt || null,
      tokenIcons,
      livePrices,
      startedAt: this.startedAt,
      session,
      autonomous: this.buildAutonomousStatus(),
      cmcMacro: getCmcMacro(),
      ...(this._cachedWalletInfo?.binancePositions?.length
        ? { binancePositions: this._cachedWalletInfo.binancePositions }
        : {}),
      userBlacklisted,
    };
    return value;
  }

  /** Operator blacklist — blocks new entries; persisted to Neon when available. */
  async addUserBlacklistToken(symbol: string): Promise<{ ok: boolean; added: boolean; symbols: string[] }> {
    const added = addUserBlacklist(symbol);
    const symbols = getUserBlacklistedTokens();
    await getAgentStore().saveUserBlacklist(symbols);
    return { ok: true, added, symbols };
  }

  async removeUserBlacklistToken(symbol: string): Promise<{ ok: boolean; removed: boolean; symbols: string[] }> {
    const removed = removeUserBlacklist(symbol);
    const symbols = getUserBlacklistedTokens();
    await getAgentStore().saveUserBlacklist(symbols);
    return { ok: true, removed, symbols };
  }
}

export interface AgentState {
  mode: string;
  running: boolean;
  cycleCount: number;
  config: AgentConfig;
  portfolio: import("./utils/types.js").PortfolioSnapshot;
  snapshots: Array<{
    timestamp: number;
    totalValueUsd: number;
    maxDrawdownPct: number;
  }>;
  trades: import("./utils/types.js").TradeResult[];
  risk: Record<string, unknown>;
  watchlist: string[];
  prices: Record<string, number>;
  bridgeSource?: string;
  tokenMetrics?: Record<string, {
    momentum: number | null;
    atrPct: number | null;
    volumeRatio?: number | null;
    score: number | null;
    newsScore?: number | null;
    newsArticles?: number;
    confidence?: number | null;
    rsi?: number | null;
    macd?: number | null;
    bbPosition?: number | null;
    vwapDev?: number | null;
    stochRsi?: number | null;
    gapPct?: number | null;
    orbBreakoutPct?: number | null;
    session?: string;
    regime?: string;
    aiSummary?: string;
    aiVerdict?: string;
    aiAgrees?: boolean;
    ohlcvReal?: boolean;
  }>;
  newsCount?: number;
  startedAt?: number;
  session?: SessionClock;
  autonomous?: AutonomousStatus;
  binancePositions?: BinanceWeb3Position[];
  lastSignalRefreshAt?: number | null;
  tokenIcons?: Record<string, string>;
  livePrices?: Record<
    string,
    { price: number; change24hPct: number; updatedAt: number }
  >;
  userBlacklisted?: string[];
  cmcMacro?: {
    at: number;
    regime: string;
    mcap24hPct: number | null;
    mcap7dPct: number | null;
    sizeScale: number;
    eventRisk: string;
    eventHint: string | null;
    summary: string;
  } | null;
}

export interface AutonomousStatus {
  phase: "stopped" | "scanning" | "idle" | "blocked";
  ready: boolean;
  headline: string;
  blockReason?: string;
  tradesToday: number;
  tradesLast24h: number;
  emergencyMode: boolean;
  nextCycleInSec: number | null;
  lastCycleAt: number | null;
  lastCycleDurationSec: number | null;
  lastCycleTrades: number;
  lastCycleQueued: number;
  tradeIntervalSec: number;
  autoExitEnabled: boolean;
  sessionPolicy: string;
  session: string;
  sessionLabel: string;
  nyTimeLabel: string;
  failedSwapCooldowns: Array<{ symbol: string; remainingMin: number }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
