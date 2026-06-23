import type { AgentConfig, MarketData, CycleResult, TradeResult, PortfolioHolding, TradeOrder, PortfolioSnapshot } from "./utils/types.js";
import { loadConfig, buildDefaultWatchlist, MOMENTUM_CORE, MOMENTUM_VOLATILE, ANCHOR_TOKENS, MAX_WATCHLIST_SIZE, ELIGIBLE_TOKENS, FULL_SCAN_INTERVAL, FULL_SCAN_BATCH_SIZE, FULL_SCAN_PROMOTE_COUNT, isEligibleToken, isStablecoin, BSC_CHAIN, MIN_POSITION_VALUE_USD } from "./config.js";
import { buildMarketData, getLatestPrice, CMC_ENDPOINTS, seedPriceHistory, getHistoryLength, parseCmcQuotesBatch, parseCmcTrending, parseFearGreedIndex, unwrapX402Response } from "./data/market.js";
import { fetchNewsFeed } from "./data/news.js";
import { analyzeMarkets, selectTrades } from "./strategy/index.js";
import { getStrategyProfile, isStrategyName } from "./strategy/presets.js";
import { resolveBscTokenAddress, hasBscSwapAddress } from "./integrations/bsc-token-addresses.js";
import { computeSignals, getTokenMomentumMetrics } from "./strategy/signals.js";
import { enrichSignalsWithAi, applyAiInsight } from "./strategy/ai-analyst.js";
import type { AiSignalInsight } from "./strategy/ai-analyst.js";
import { analyzeNewsSentiment, type NewsSentiment } from "./strategy/news-sentiment.js";
import { RiskManager } from "./risk/manager.js";
import { PortfolioTracker } from "./risk/portfolio.js";
import {
  validateAndCreateOrder,
  buildSwapParams,
  buildQuoteParams,
  processSwapResult,
  applyTradeToPortfolio,
  isOnChainTxHash,
} from "./execution/executor.js";
import { logger } from "./utils/logger.js";
import { getAgentStore } from "./db/store.js";
import { fetchBscTokenBalances, scanWalletViaCliSubprocess } from "./integrations/bscscan.js";
import { fetchWalletTradeHistory } from "./integrations/trade-history.js";
import { fetchBinanceWeb3Holdings, fetchWalletPositions, type BinanceWeb3Position } from "./integrations/binance-web3-wallet.js";

/**
 * Core autonomous trading agent — Neural Alpha.
 *
 * Architecture:
 *   CMC Agent Hub (x402) → Market Data → Strategy Engine → Risk Manager → TWAK Swap → BSC
 *
 * The agent operates in two modes:
 * 1. MCP-orchestrated: An AI agent calls TWAK MCP tools and feeds results
 *    to this engine. The agent class provides the decision logic.
 * 2. Standalone: The agent runs its own loop (for demo/testing), using
 *    direct HTTP calls or mock data.
 *
 * All execution goes through TWAK — self-custody, local signing, no
 * custodial intermediaries.
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

export interface WalletInfo {
  address: string | null;
  bnbBalance: number;
  usdtBalance: number;
  walletMode: string;
  walletState: string;
  registered: boolean;
  registrationOpen: boolean;
  binancePositions?: BinanceWeb3Position[];
}

export class TradingAgent {
  private config: AgentConfig;
  private portfolio: PortfolioTracker;
  private riskManager: RiskManager;
  private mcp: McpBridge;
  private cycleCount = 0;
  private running = false;
  private runGeneration = 0;
  private fearGreedIndex: number | null = null;
  private watchlist: string[];
  private lastSignals: Map<string, number> = new Map();
  private lastSignalConfidence: Map<string, number> = new Map();
  private lastNewsSentiment: Map<string, NewsSentiment> = new Map();
  private lastNewsCount = 0;
  private lastAiInsights = new Map<string, AiSignalInsight>();
  private bridgeSource = "unknown";
  private x402Payment = process.env.CMC_X402_MAX_PAYMENT || "10000";
  private startedAt = Date.now();
  /** Autonomous swap failures — prevents approve+retry spam on the same token. */
  private failedSwapUntil = new Map<string, number>();
  /** Estimated autonomous on-chain txs sent today (approve + swap ≈ 2 each). */
  private autonomousOnChainTxToday = 0;
  private autonomousTxDay = "";

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
      maxDailyTrades: this.config.maxDailyTrades,
      maxPositionSize: this.config.maxPositionSizeUsd,
      tradeInterval: this.config.tradeIntervalMs,
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

      if (this.portfolio.getTradeHistory().length === 0) {
        await this.backfillTradeHistoryFromChain();
      }
    }

    this.getWalletInfo().catch(() => {});

    logger.info("Agent started — entering trading loop", {
      interval: `${this.config.tradeIntervalMs / 1000}s`,
      startupCooldownSec: this.config.startupCooldownMs / 1000,
    });

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
    logger.info("Agent stop requested");
  }

  /**
   * Execute one full trading cycle:
   * 1. Fetch market data from CMC (x402) and TWAK
   * 2. Compute technical signals
   * 3. Generate trade decisions
   * 4. Validate against risk guardrails
   * 5. Execute approved trades via TWAK
   * 6. Update portfolio and log results
   */
  async runCycle(): Promise<CycleResult> {
    const startTime = Date.now();
    this.cycleCount++;
    const cycleId = this.cycleCount;

    logger.info(`=== Cycle ${cycleId} ===`);

    if (this.config.mode === "live") {
      await this.reconcileLivePortfolio();
    }

    // Step 1: Fetch news sentiment (ClipX) — used by full scan + signals
    const newsSentiment = await this.fetchNews();

    // Step 2: Fetch market data
    const markets = await this.fetchMarketData();

    // Step 3: Fetch macro sentiment (Fear & Greed via CMC x402)
    await this.fetchSentiment();

    // Step 4: Analyze markets and generate signals
    let signals = analyzeMarkets(markets, this.fearGreedIndex, this.config, newsSentiment);

    // Step 4b: AI technical analysis on top actionable signals (optional)
    const technicalsMap = new Map(
      markets.map((m) => [m.symbol, computeSignals(m.symbol)] as const)
    );
    this.lastAiInsights = await enrichSignalsWithAi(
      signals,
      markets,
      technicalsMap,
      this.fearGreedIndex
    );
    if (this.lastAiInsights.size > 0) {
      signals = signals.map((s) =>
        applyAiInsight(s, this.lastAiInsights.get(s.symbol.toUpperCase()))
      );
    }

    // Persist (don't clear) so scores from periodic full eligible-token scans
    // remain visible on the dashboard between scans — otherwise full-scan-only
    // tokens (e.g. most Binance Alpha names) would vanish on non-scan cycles.
    for (const s of signals) {
      this.lastSignals.set(s.symbol, s.score);
      this.lastSignalConfidence.set(s.symbol, s.confidence);
    }

    // Step 3b: Protective exits — stop-loss, take-profit, trailing stop (optional).
    const currentPrices = new Map<string, number>();
    for (const m of markets) {
      currentPrices.set(m.symbol, m.price);
    }
    const trailingSells: import("./utils/types.js").TradeSignal[] = [];
    if (this.config.autoExitEnabled) {
      const riskExits = this.portfolio.getRiskManagedExits(currentPrices, {
        stopLossPct: this.config.stopLossPct,
        takeProfitPct: this.config.takeProfitPct,
        trailingActivatePct: this.config.trailingActivatePct,
        trailingGivebackPct: this.config.trailingGivebackPct,
      });
      for (const exit of riskExits) {
        trailingSells.push({
          symbol: exit.symbol,
          action: "sell",
          strength: "strong_sell",
          score: -100,
          reasons: [exit.reason],
          targetAllocationPct: 0,
          confidence: 1,
        });
      }
      if (trailingSells.length > 0) {
        logger.risk("Protective exit triggered", {
          exits: riskExits.map((e) => ({
            symbol: e.symbol,
            kind: e.kind,
            pnlPct: Math.round(e.pnlPct * 10) / 10,
          })),
        });
      }
    }

    // Step 4: Select best trades
    const existingPositions = new Set(this.portfolio.getAllPositions().keys());
    const tradesToExecute = selectTrades(signals, this.config, existingPositions);

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
      tradesToExecute.splice(0, tradesToExecute.length,
        ...tradesToExecute.filter((t) => t.action === "sell")
      );

      if (this.portfolio.getMaxDrawdown() >= this.config.maxDrawdownPct) {
        logger.risk("MAX DRAWDOWN REACHED — buying paused, holding positions (no auto-liquidation)");
      }
    }

    // Step 6: Execute trades (autonomous only — manual commands bypass cooldown)
    const tradeResults: TradeResult[] = [];
    const inStartupCooldown = this.isInStartupCooldown();
    const maxPerCycle = this.config.maxAutonomousTradesPerCycle;
    if (inStartupCooldown && tradesToExecute.length > 0) {
      const remainingSec = Math.ceil(this.getStartupCooldownRemainingMs() / 1000);
      logger.info("Startup cooldown — autonomous trades paused", {
        remainingSec,
        queued: tradesToExecute.length,
      });
    } else if (tradesToExecute.length > maxPerCycle) {
      logger.info("Autonomous trade queue trimmed to per-cycle cap", {
        queued: tradesToExecute.length,
        executing: maxPerCycle,
        skipped: tradesToExecute.slice(maxPerCycle).map((t) => t.symbol),
      });
    }
    let autonomousExecuted = 0;
    for (const signal of tradesToExecute) {
      if (inStartupCooldown) continue;
      if (autonomousExecuted >= maxPerCycle) break;
      const result = await this.executeTrade(signal);
      if (result?.success) {
        tradeResults.push(result);
        autonomousExecuted++;
      }
    }

    // Step 6b: Re-sync with on-chain reality before snapshot so phantom
    // trades don't inflate peak NAV / drawdown.
    if (this.config.mode === "live") {
      await this.reconcileLivePortfolio(currentPrices);
    }

    // Step 7: Take portfolio snapshot
    const snapshot = this.portfolio.snapshot(currentPrices);
    await this.persistCycleSnapshot(cycleId, snapshot);

    // Step 8: Log risk summary
    logger.info("Risk status", this.riskManager.riskSummary());

    // Step 9: Min daily trade enforcement (competition requires ≥1 trade/day)
    const todayTrades = this.portfolio.getTodayTradeCount();
    const hour = new Date().getUTCHours();
    if (
      todayTrades === 0 &&
      hour >= 20 &&
      this.config.mode === "live" &&
      !this.isInStartupCooldown() &&
      autonomousExecuted < maxPerCycle
    ) {
      logger.risk("WARNING: 0 trades today — competition requires ≥1 trade/day. Forcing best available trade.");
      const bestSignal = signals.find((s) => s.action !== "hold" && Math.abs(s.score) > 5);
      if (bestSignal) {
        const result = await this.executeTrade(bestSignal);
        if (result?.success) tradeResults.push(result);
      }
    } else if (todayTrades === 0 && hour >= 18) {
      logger.warn("No trades today yet — competition requires ≥1/day (June 22-28)", { hour });
    }

    return {
      cycleId,
      timestamp: Date.now(),
      marketsAnalyzed: markets.length,
      signalsGenerated: signals,
      tradesExecuted: tradeResults,
      portfolioSnapshot: snapshot,
      duration: Date.now() - startTime,
    };
  }

  private async fetchMarketData(): Promise<MarketData[]> {
    const markets: MarketData[] = [];
    let trendingTokens: Array<{ symbol: string }> | null = null;

    const tokensToCheck = new Set([
      ...this.watchlist,
      ...this.portfolio.getAllPositions().keys(),
    ]);
    const symbols = [...tokensToCheck];

    // Tier 2: full eligible-token scan every N cycles — and once up-front on
    // the first cycle so the dashboard (incl. Binance Alpha) populates fast.
    if (this.cycleCount <= 1 || this.cycleCount % FULL_SCAN_INTERVAL === 0) {
      await this.runFullTokenScan(markets);
    }

    // Primary: CMC Agent Hub quotes via x402 (batch = fewer micropayments)
    const cmcQuotes = await this.fetchCmcQuotes(symbols);
    for (const md of cmcQuotes.values()) {
      markets.push(md);
    }

    // Fallback: TWAK spot prices for symbols CMC did not return
    for (const symbol of symbols) {
      if (cmcQuotes.has(symbol)) continue;
      try {
        const priceData = await this.mcp.getTokenPrice(BSC_CHAIN, symbol);
        if (priceData) {
          if (getHistoryLength(symbol) < 40) {
            seedPriceHistory(symbol, priceData.price, 50, 3.5);
          }
          markets.push(buildMarketData(symbol, priceData.price));
        }
      } catch (err) {
        logger.warn(`TWAK price fallback failed for ${symbol}`, { error: String(err) });
      }
    }

    // Trending: CMC Agent Hub x402 first, TWAK fallback
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
        .filter((t) => isEligibleToken(t.symbol) && !tokensToCheck.has(t.symbol))
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
            if (getHistoryLength(symbol) < 40) {
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
      fullScanCycle: this.cycleCount % FULL_SCAN_INTERVAL === 0,
    });
    return markets;
  }

  /**
   * Tier 2 scan: quote all eligible tokens in batches, record prices,
   * promote top movers into the active watchlist.
   */
  private async runFullTokenScan(existingMarkets: MarketData[]) {
    const tradable = ELIGIBLE_TOKENS.filter((s) => !isStablecoin(s));
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
          if (getHistoryLength(symbol) < 40) {
            seedPriceHistory(symbol, md.price, 50, 3.5);
          }
          out.set(symbol, md);
        }
      } catch (err) {
        logger.warn("CMC x402 batch quote failed", { batch: batch.join(","), error: String(err) });
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
      ...MOMENTUM_CORE,
      ...ANCHOR_TOKENS,
      ...positions,
      ...this.watchlist,
    ]);

    if (trending) {
      for (const t of trending) {
        if (isEligibleToken(t.symbol)) next.add(t.symbol);
      }
    }

    for (const m of markets) {
      if (MOMENTUM_VOLATILE.includes(m.symbol)) next.add(m.symbol);
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

  private async fetchSentiment() {
    try {
      const result = await this.mcp.x402Request(
        CMC_ENDPOINTS.fearGreed(),
        this.x402Payment
      );
      const value = parseFearGreedIndex(unwrapX402Response(result) ?? {});
      if (value !== null) {
        this.fearGreedIndex = value;
        logger.info("Fear & Greed Index updated (CMC x402)", { value });
      }
    } catch {
      logger.warn("Failed to fetch Fear & Greed — using last known value", {
        lastKnown: this.fearGreedIndex,
      });
    }
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

  private isInStartupCooldown(): boolean {
    return this.getStartupCooldownRemainingMs() > 0;
  }

  private getStartupCooldownRemainingMs(): number {
    return Math.max(0, this.config.startupCooldownMs - (Date.now() - this.startedAt));
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

  private resetAutonomousTxDayIfNeeded() {
    const today = new Date().toISOString().split("T")[0];
    if (this.autonomousTxDay !== today) {
      this.autonomousTxDay = today;
      this.autonomousOnChainTxToday = 0;
    }
  }

  /** Each live swap typically costs 2 on-chain txs (approve + swap). */
  private static readonly TX_PER_SWAP = 2;

  private autonomousTxBudgetRemaining(): number {
    this.resetAutonomousTxDayIfNeeded();
    return Math.max(0, this.config.maxOnChainTxPerDay - this.autonomousOnChainTxToday);
  }

  private canExecuteAutonomousTrade(): { ok: boolean; reason?: string } {
    const dailyTrades = this.portfolio.getTodayTradeCount();
    if (dailyTrades >= this.config.maxDailyTrades) {
      return {
        ok: false,
        reason: `daily autonomous trade cap (${this.config.maxDailyTrades})`,
      };
    }
    if (this.autonomousTxBudgetRemaining() < TradingAgent.TX_PER_SWAP) {
      return {
        ok: false,
        reason: `on-chain tx budget (${this.config.maxOnChainTxPerDay}/day)`,
      };
    }
    return { ok: true };
  }

  private reserveAutonomousOnChainTx() {
    this.resetAutonomousTxDayIfNeeded();
    this.autonomousOnChainTxToday += TradingAgent.TX_PER_SWAP;
  }

  private async executeTrade(
    signal: import("./utils/types.js").TradeSignal,
    opts: { manual?: boolean; order?: import("./utils/types.js").TradeOrder } = {}
  ): Promise<TradeResult | null> {
    if (!opts.manual && this.isInStartupCooldown()) {
      logger.info("Trade deferred — startup cooldown active", {
        symbol: signal.symbol,
        action: signal.action,
        remainingSec: Math.ceil(this.getStartupCooldownRemainingMs() / 1000),
      });
      return null;
    }

    if (!opts.manual && this.isInFailedSwapCooldown(signal.symbol)) {
      const until = this.failedSwapUntil.get(signal.symbol.toUpperCase()) ?? 0;
      logger.info("Trade skipped — recent failed swap cooldown", {
        symbol: signal.symbol,
        remainingMin: Math.ceil((until - Date.now()) / 60000),
      });
      return null;
    }

    if (!opts.manual && this.config.mode === "live") {
      const gate = this.canExecuteAutonomousTrade();
      if (!gate.ok) {
        logger.info("Autonomous trade blocked", {
          symbol: signal.symbol,
          reason: gate.reason,
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
      return result;
    }

    // Live mode: get quote first, then execute
    try {
      // For sells, settle the swap amount against the wallet's ACTUAL
      // transferable balance. The internally tracked position amount can drift
      // above the on-chain balance (stale sync, rounding, dust), which makes
      // TWAK revert with "BEP20: transfer amount exceeds balance". Always sell
      // the real available balance (minus a tiny margin for precision).
      if (order.side === "sell") {
        const onChainBalance = await this.getOnChainTokenBalance(order.fromToken);
        if (onChainBalance !== null && onChainBalance > 0) {
          const tracked = order.fromTokenAmount ?? onChainBalance;
          // Never sell more than the wallet actually holds.
          const sellable = Math.min(tracked, onChainBalance);
          // 0.1% haircut absorbs decimal/precision mismatches so the transfer
          // can never round above the true balance.
          const safeAmount = sellable * 0.999;
          if (safeAmount > 0 && safeAmount !== order.fromTokenAmount) {
            logger.info("Reconciled sell amount to on-chain balance", {
              symbol: order.symbol,
              trackedAmount: tracked,
              onChainBalance,
              sellAmount: safeAmount,
            });
            order.fromTokenAmount = safeAmount;
          }
        } else {
          logger.warn("Could not resolve on-chain balance for sell — using tracked amount", {
            symbol: order.symbol,
            trackedAmount: order.fromTokenAmount,
          });
        }
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
      if (!opts.manual) this.reserveAutonomousOnChainTx();
      const swapResult = await this.mcp.executeSwap(swapParams);

      logger.info("TWAK swap raw response", {
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
        try {
          await this.syncWalletCapital();
        } catch (err) {
          logger.warn("Post-trade wallet sync failed", { error: String(err) });
        }
      } else {
        logger.warn("Live swap not confirmed on-chain — portfolio unchanged", {
          orderId: order.id,
          symbol: order.symbol,
          error: result.error,
        });
        if (!opts.manual) this.markFailedSwap(order.symbol);
      }

      return result;
    } catch (err) {
      if (!opts.manual) this.markFailedSwap(signal.symbol);
      logger.error("Trade execution error", {
        orderId: order.id,
        symbol: order.symbol,
        error: String(err),
      });
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
   * isn't on the active watchlist. Resolves the BEP-20 contract (static map →
   * CMC lookup, cached) and fetches a live price (CMC quote → TWAK spot),
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
        logger.warn("Manual-trade TWAK price prime failed", { symbol: sym, error: String(err) });
      }
    }

    const price = getLatestPrice(sym);
    const routable = hasBscSwapAddress(sym) && price !== null;
    logger.info("Primed token for manual trade", { symbol: sym, address: address ?? "unmapped", price, routable });
    return { routable, price, address };
  }

  async executeManualTrade(
    signal: import("./utils/types.js").TradeSignal,
    opts: { amountUsd?: number } = {}
  ): Promise<{
    result: TradeResult | null;
    violations?: string[];
    tradeSizeUsd: number;
  }> {
    // Resolve contract + price up-front so any eligible token is tradable,
    // not just ones currently on the watchlist.
    await this.primeTokenForTrade(signal.symbol);

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
  updateConfig(partial: Partial<AgentConfig>) {
    const changed: Record<string, unknown> = {};

    // Switching strategy applies that preset's risk profile + sizing first;
    // any explicit fields in the same payload then override on top.
    if (partial.strategy !== undefined && isStrategyName(partial.strategy)) {
      const profile = getStrategyProfile(partial.strategy);
      this.config.strategy = profile.name;
      this.config.positionSizeMultiplier = profile.positionSizeMultiplier;
      this.config.maxDrawdownPct = profile.risk.maxDrawdownPct;
      this.config.maxDailyTrades = profile.risk.maxDailyTrades;
      this.config.maxPortfolioTokens = profile.risk.maxPortfolioTokens;
      this.config.minBuyConfidence = profile.risk.minBuyConfidence;
      this.config.stopLossPct = profile.risk.stopLossPct;
      this.config.takeProfitPct = profile.risk.takeProfitPct;
      this.config.trailingActivatePct = profile.risk.trailingActivatePct;
      this.config.trailingGivebackPct = profile.risk.trailingGivebackPct;
      changed.strategy = profile.name;
    }

    const safe: (keyof AgentConfig)[] = [
      "tradeIntervalMs", "maxPositionSizeUsd", "maxDailyTrades",
      "maxDrawdownPct", "slippageTolerance", "maxPortfolioTokens",
      "minTradeAmountUsd", "minBuyConfidence", "stopLossPct", "takeProfitPct",
      "trailingActivatePct", "trailingGivebackPct", "autoExitEnabled",
      "maxAutonomousTradesPerCycle", "maxOnChainTxPerDay",
    ];
    for (const key of safe) {
      if (partial[key] !== undefined) {
        (this.config as unknown as Record<string, unknown>)[key] = partial[key];
        changed[key] = partial[key];
      }
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

  getFearGreedIndex(): number | null {
    return this.fearGreedIndex;
  }

  /**
   * Resolve the real BSC wallet address.
   * Prefers the live TWAK MCP address; falls back to AGENT_WALLET_ADDRESS env
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

  /** Read TWAK wallet address + on-chain balances for dashboard. */
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

    const info: WalletInfo = {
      address,
      bnbBalance: Math.round(bnbBalance * 10000) / 10000,
      usdtBalance: Math.round(usdtBalance * 100) / 100,
      walletMode,
      walletState,
      registered,
      registrationOpen,
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
  }

  private async bootstrapPersistence() {
    const store = getAgentStore();
    let dbTrades: import("./utils/types.js").TradeResult[] = [];

    if (store.enabled) {
      const navState = await store.loadNavState();
      if (navState) this.portfolio.restorePersistedNav(navState);

      const wallet = await this.resolveBootstrapWalletAddress();
      dbTrades = await store.loadRecentTrades(50, wallet);
      if (dbTrades.length > 0) this.portfolio.hydrateTradeHistory(dbTrades);
    }

    await this.backfillTradeHistoryFromChain(dbTrades);
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
      logger.warn("Trade history backfill skipped — set AGENT_WALLET_ADDRESS or bind TWAK wallet");
      return;
    }

    const knownHashes = new Set(
      existing.map((t) => t.txHash?.toLowerCase()).filter(Boolean) as string[]
    );
    for (const t of this.portfolio.getTradeHistory()) {
      if (t.txHash) knownHashes.add(t.txHash.toLowerCase());
    }

    const chainTrades = await fetchWalletTradeHistory(wallet, 50);
    const novel = chainTrades.filter(
      (t) => t.txHash && !knownHashes.has(t.txHash.toLowerCase())
    );

    if (novel.length === 0) {
      if (this.portfolio.getTradeHistory().length === 0 && chainTrades.length > 0) {
        this.portfolio.hydrateTradeHistory(chainTrades);
        logger.info("Trade history hydrated from chain (memory only)", {
          count: chainTrades.length,
          wallet: wallet.slice(0, 10) + "…",
        });
      }
      return;
    }

    this.portfolio.hydrateTradeHistory(novel);

    const store = getAgentStore();
    if (store.enabled) {
      await Promise.all(novel.map((t) => store.saveChainTrade(t, wallet)));
    }

    logger.info("Trade history backfilled from chain", {
      imported: novel.length,
      wallet: wallet.slice(0, 10) + "…",
    });
  }

  /** Wallet address for DB scoping before TWAK cache is warm. */
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
    if (!store.enabled) return;
    await store.saveTrade(order, result, this.config.mode, twakResponse, this.currentWalletAddress());
    if (result.success) {
      this.portfolio.markTradePersisted(result.orderId);
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

  /** Compute key agent stats for persistence (win rate, trades, sentiment, etc.). */
  private computeCycleStats(snap: PortfolioSnapshot): import("./db/store.js").CycleStats {
    const trades = this.portfolio.getTradeHistory().filter((t) => t.success);
    const closed = trades.filter((t) => t.realizedPnl !== undefined);
    const wins = closed.filter((t) => (t.realizedPnl ?? 0) >= 0).length;
    const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

    return {
      realizedPnl: this.portfolio.realizedPnl,
      dailyPnl: snap.dailyPnl,
      positionsCount: snap.positions.length,
      totalTrades: trades.length,
      todayTrades: this.portfolio.getTodayTradeCount(),
      winRate: Math.round(winRate * 10) / 10,
      fearGreed: this.fearGreedIndex,
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
    } else {
      await this.syncWalletCapital().catch(() => undefined);
    }
    logger.info("Manual portfolio resync requested");
    return this.getStateSnapshot();
  }

  /**
   * Rebuild tracked positions from the wallet's actual on-chain holdings so
   * NAV / allocation / PnL reflect every token held — including assets bought
   * outside this agent run. Eligible, non-stablecoin tokens only.
   */
  /**
   * Best-effort lookup of the wallet's actual transferable balance for a single
   * token symbol. Prefers the direct per-token balance call, then falls back to
   * scanning the full on-chain portfolio. Returns null when neither is available.
   */
  private async getOnChainTokenBalance(symbol: string): Promise<number | null> {
    const sym = symbol.toUpperCase();

    if (this.mcp.getTokenBalance) {
      try {
        const bal = await this.mcp.getTokenBalance(BSC_CHAIN, sym);
        if (bal && typeof bal.amount === "number" && bal.amount > 0) {
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
          return match.amount;
        }
      } catch (err) {
        logger.warn("getPortfolio lookup failed during sell reconcile", {
          symbol: sym,
          error: String(err),
        });
      }
    }

    return null;
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

      // TWAK balance APIs can echo native BNB for unrelated ERC-20 queries.
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
      logger.warn("Could not read USDT balance — TWAK wallet not connected?");
      return { usdtBalance: this.portfolio.cash, synced: false };
    }

    this.portfolio.setCashUsd(stable.balance);

    // Anchor the NAV baseline to real capital on the first successful sync.
    // NAV = on-chain cash + current value of any tracked positions.
    if (!this.portfolio.hasBaseline) {
      const positionsValue = this.estimateTrackedPositionsValue();
      this.portfolio.setBaselineNav(
        stable.balance + positionsValue + this.portfolio.gasReserve.valueUsd
      );
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
      throw new Error("Competition registration requires TWAK MCP (twak serve)");
    }
    const result = await this.mcp.competitionRegister();
    if (!result) throw new Error("Registration failed — check TWAK logs");
    logger.info("Competition registration submitted", result);
    return result;
  }

  async switchWalletMode(mode: "local" | "walletconnect"): Promise<Record<string, unknown>> {
    if (!this.mcp.switchWalletMode) {
      throw new Error("Wallet mode switch requires TWAK MCP (twak serve)");
    }
    const result = await this.mcp.switchWalletMode(mode);
    if (!result) throw new Error("Wallet mode switch failed");
    logger.info("Wallet mode switched", { mode });
    return result;
  }

  /**
   * Full agent state snapshot for dashboard / API consumers.
   */
  getStateSnapshot(): AgentState {
    // Report the full set of analyzed tokens (watchlist + every token scored in
    // the last cycle, incl. full-scan / Binance Alpha promotions), not just the
    // 15-token trading watchlist — so the dashboard can show all of them.
    const reportSymbols = Array.from(
      new Set<string>([...this.watchlist, ...this.lastSignals.keys()])
    );

    const currentPrices = new Map<string, number>();
    for (const symbol of reportSymbols) {
      const price = getLatestPrice(symbol);
      if (price !== null) currentPrices.set(symbol, price);
    }
    for (const symbol of this.portfolio.getAllPositions().keys()) {
      const price = getLatestPrice(symbol);
      if (price !== null) currentPrices.set(symbol, price);
    }

    const portfolioSnap = this.portfolio.snapshot(currentPrices);
    const snapshots = this.portfolio.getSnapshots();

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
      aiSummary?: string;
      aiVerdict?: string;
      aiAgrees?: boolean;
    }> = {};
    for (const symbol of reportSymbols) {
      const { momentum, atrPct, volumeRatio } = getTokenMomentumMetrics(symbol);
      const sig = this.lastSignals.get(symbol);
      const news = this.lastNewsSentiment.get(symbol);
      const tech = computeSignals(symbol);
      const ai = this.lastAiInsights.get(symbol.toUpperCase());
      tokenMetrics[symbol] = {
        momentum,
        atrPct,
        volumeRatio: volumeRatio !== null ? Math.round(volumeRatio * 100) / 100 : null,
        score: sig !== undefined ? Math.round(sig) : null,
        confidence: this.lastSignalConfidence.get(symbol) ?? null,
        newsScore: news?.score ?? null,
        newsArticles: news?.articles ?? 0,
        rsi: tech.rsi !== null ? Math.round(tech.rsi * 10) / 10 : null,
        macd: tech.macd?.histogram ?? null,
        ...(ai
          ? {
              aiSummary: ai.summary,
              aiVerdict: ai.verdict,
              aiAgrees: ai.agreesWithSignal,
            }
          : {}),
      };
    }

    return {
      mode: this.config.mode,
      running: this.running,
      cycleCount: this.cycleCount,
      config: this.config,
      portfolio: portfolioSnap,
      snapshots,
      trades: this.portfolio.getTradeHistory(),
      risk: this.riskManager.riskSummary(),
      watchlist: reportSymbols,
      fearGreedIndex: this.fearGreedIndex,
      prices: Object.fromEntries(currentPrices),
      bridgeSource: this.bridgeSource,
      tokenMetrics,
      newsCount: this.lastNewsCount,
      startedAt: this.startedAt,
      startupCooldownActive: this.isInStartupCooldown(),
      startupCooldownRemainingMs: this.getStartupCooldownRemainingMs(),
      ...(this._cachedWalletInfo?.binancePositions?.length
        ? { binancePositions: this._cachedWalletInfo.binancePositions }
        : {}),
    };
  }
}

export interface AgentState {
  mode: string;
  running: boolean;
  cycleCount: number;
  config: AgentConfig;
  portfolio: import("./utils/types.js").PortfolioSnapshot;
  snapshots: import("./utils/types.js").PortfolioSnapshot[];
  trades: import("./utils/types.js").TradeResult[];
  risk: Record<string, unknown>;
  watchlist: string[];
  fearGreedIndex: number | null;
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
    aiSummary?: string;
    aiVerdict?: string;
    aiAgrees?: boolean;
  }>;
  newsCount?: number;
  startedAt?: number;
  startupCooldownActive?: boolean;
  startupCooldownRemainingMs?: number;
  binancePositions?: BinanceWeb3Position[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
