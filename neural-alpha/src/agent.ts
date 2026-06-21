import type { AgentConfig, MarketData, CycleResult, TradeResult } from "./utils/types.js";
import { loadConfig, buildDefaultWatchlist, MOMENTUM_CORE, MOMENTUM_VOLATILE, ANCHOR_TOKENS, MAX_WATCHLIST_SIZE, ELIGIBLE_TOKENS, FULL_SCAN_INTERVAL, FULL_SCAN_BATCH_SIZE, FULL_SCAN_PROMOTE_COUNT, isEligibleToken, isStablecoin, BSC_CHAIN } from "./config.js";
import { buildMarketData, getLatestPrice, CMC_ENDPOINTS, seedPriceHistory, getHistoryLength, parseCmcQuotesBatch, parseCmcTrending, parseFearGreedIndex, unwrapX402Response } from "./data/market.js";
import { fetchNewsFeed } from "./data/news.js";
import { analyzeMarkets, selectTrades } from "./strategy/index.js";
import { getTokenMomentumMetrics } from "./strategy/signals.js";
import { analyzeNewsSentiment, type NewsSentiment } from "./strategy/news-sentiment.js";
import { RiskManager } from "./risk/manager.js";
import { PortfolioTracker } from "./risk/portfolio.js";
import {
  validateAndCreateOrder,
  buildSwapParams,
  buildQuoteParams,
  processSwapResult,
  applyTradeToPortfolio,
} from "./execution/executor.js";
import { logger } from "./utils/logger.js";

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
}

export class TradingAgent {
  private config: AgentConfig;
  private portfolio: PortfolioTracker;
  private riskManager: RiskManager;
  private mcp: McpBridge;
  private cycleCount = 0;
  private running = false;
  private fearGreedIndex: number | null = null;
  private watchlist: string[];
  private lastSignals: Map<string, number> = new Map();
  private lastNewsSentiment: Map<string, NewsSentiment> = new Map();
  private lastNewsCount = 0;
  private bridgeSource = "unknown";
  private x402Payment = process.env.CMC_X402_MAX_PAYMENT || "10000";
  private startedAt = Date.now();

  constructor(mcp: McpBridge, initialCashUsd = 1000, bridgeSource = "unknown") {
    this.config = loadConfig();
    this.portfolio = new PortfolioTracker(initialCashUsd);
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
    this.running = true;
    this.startedAt = Date.now();

    // Live mode: seed portfolio cash from on-chain USDT
    if (this.config.mode === "live" && this.mcp.getStablecoinBalance) {
      try {
        await this.syncWalletCapital();
      } catch (err) {
        logger.warn("Initial wallet sync failed", { error: String(err) });
      }
    }

    logger.info("Agent started — entering trading loop", {
      interval: `${this.config.tradeIntervalMs / 1000}s`,
    });

    while (this.running) {
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

      if (this.running) {
        await sleep(this.config.tradeIntervalMs);
      }
    }
  }

  stop() {
    this.running = false;
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

    // Step 1: Fetch news sentiment (ClipX) — used by full scan + signals
    const newsSentiment = await this.fetchNews();

    // Step 2: Fetch market data
    const markets = await this.fetchMarketData();

    // Step 3: Fetch macro sentiment (Fear & Greed via CMC x402)
    await this.fetchSentiment();

    // Step 4: Analyze markets and generate signals
    const signals = analyzeMarkets(markets, this.fearGreedIndex, this.config, newsSentiment);
    this.lastSignals.clear();
    for (const s of signals) {
      this.lastSignals.set(s.symbol, s.score);
    }

    // Step 3b: Trailing stop-loss — lock momentum profits
    const currentPrices = new Map<string, number>();
    for (const m of markets) {
      currentPrices.set(m.symbol, m.price);
    }
    const trailingStopSymbols = this.portfolio.getTrailingStopSells(currentPrices);
    const trailingSells = trailingStopSymbols.map((symbol) => ({
      symbol,
      action: "sell" as const,
      strength: "strong_sell" as const,
      score: -100,
      reasons: ["Trailing stop — peaked +5%, fell back to +1.5%"],
      targetAllocationPct: 0,
      confidence: 1,
    }));
    if (trailingSells.length > 0) {
      logger.risk("Trailing stop triggered", { symbols: trailingStopSymbols });
    }

    // Step 4: Select best trades
    const existingPositions = new Set(this.portfolio.getAllPositions().keys());
    const tradesToExecute = selectTrades(signals, this.config, existingPositions);

    // Prepend trailing stops (highest priority exits)
    for (const ts of trailingSells) {
      if (!tradesToExecute.find((t) => t.symbol === ts.symbol)) {
        tradesToExecute.unshift(ts);
      }
    }

    // Step 5: Check for emergency mode
    if (this.riskManager.isEmergencyMode()) {
      logger.risk("EMERGENCY MODE — high drawdown, only sells allowed", this.riskManager.riskSummary());
      tradesToExecute.splice(0, tradesToExecute.length,
        ...tradesToExecute.filter((t) => t.action === "sell")
      );

      // Force sell all positions if drawdown exceeds limit
      if (this.portfolio.getMaxDrawdown() >= this.config.maxDrawdownPct) {
        logger.risk("MAX DRAWDOWN BREACHED — liquidating all positions");
        for (const symbol of existingPositions) {
          const forceSell = {
            symbol,
            action: "sell" as const,
            strength: "strong_sell" as const,
            score: -100,
            reasons: ["Emergency liquidation — max drawdown breached"],
            targetAllocationPct: 0,
            confidence: 1,
          };
          if (!tradesToExecute.find((t) => t.symbol === symbol)) {
            tradesToExecute.push(forceSell);
          }
        }
      }
    }

    // Step 6: Execute trades
    const tradeResults: TradeResult[] = [];
    for (const signal of tradesToExecute) {
      const result = await this.executeTrade(signal);
      if (result) tradeResults.push(result);
    }

    // Step 7: Take portfolio snapshot
    const snapshot = this.portfolio.snapshot(currentPrices);

    // Step 8: Log risk summary
    logger.info("Risk status", this.riskManager.riskSummary());

    // Step 9: Min daily trade enforcement (competition requires ≥1 trade/day)
    const todayTrades = this.portfolio.getTodayTradeCount();
    const hour = new Date().getUTCHours();
    if (todayTrades === 0 && hour >= 20 && this.config.mode === "live") {
      logger.risk("WARNING: 0 trades today — competition requires ≥1 trade/day. Forcing best available trade.");
      const bestSignal = signals.find((s) => s.action !== "hold" && Math.abs(s.score) > 5);
      if (bestSignal) {
        const result = await this.executeTrade(bestSignal);
        if (result) tradeResults.push(result);
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

    // Tier 2: full eligible-token scan every N cycles
    if (this.cycleCount % FULL_SCAN_INTERVAL === 0) {
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

  private async executeTrade(signal: import("./utils/types.js").TradeSignal): Promise<TradeResult | null> {
    const validation = validateAndCreateOrder(signal, this.riskManager, this.config);

    if (!validation.approved || !validation.order) {
      logger.info("Trade not approved", {
        symbol: signal.symbol,
        reasons: validation.violations,
      });
      return null;
    }

    const order = validation.order;

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
      return result;
    }

    // Live mode: get quote first, then execute
    try {
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

      const price = getLatestPrice(order.symbol) || 0;
      const result = processSwapResult(order, swapResult, price);

      applyTradeToPortfolio(order, result, this.portfolio);
      return result;
    } catch (err) {
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
    const safe: (keyof AgentConfig)[] = [
      "tradeIntervalMs", "maxPositionSizeUsd", "maxDailyTrades",
      "maxDrawdownPct", "slippageTolerance", "maxPortfolioTokens",
      "minTradeAmountUsd",
    ];
    const changed: Record<string, unknown> = {};
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

  getCycleCount(): number {
    return this.cycleCount;
  }

  getWatchlist(): string[] {
    return [...this.watchlist];
  }

  getFearGreedIndex(): number | null {
    return this.fearGreedIndex;
  }

  /** Read TWAK wallet address + on-chain balances for dashboard. */
  async getWalletInfo(): Promise<WalletInfo> {
    const addrResult = await this.mcp.getAddress(BSC_CHAIN);
    const address = addrResult?.address ?? null;

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

    return {
      address,
      bnbBalance: Math.round(bnbBalance * 10000) / 10000,
      usdtBalance: Math.round(usdtBalance * 100) / 100,
      walletMode,
      walletState,
      registered,
      registrationOpen,
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
    logger.info("Wallet capital synced from chain", {
      usdt: stable.balance,
      symbol: stable.symbol,
    });

    return { usdtBalance: stable.balance, synced: true };
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
    const currentPrices = new Map<string, number>();
    for (const symbol of this.watchlist) {
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
      score: number | null;
      newsScore: number | null;
      newsArticles: number;
    }> = {};
    for (const symbol of this.watchlist) {
      const { momentum, atrPct } = getTokenMomentumMetrics(symbol);
      const sig = this.lastSignals.get(symbol);
      const news = this.lastNewsSentiment.get(symbol);
      tokenMetrics[symbol] = {
        momentum,
        atrPct,
        score: sig !== undefined ? Math.round(sig) : null,
        newsScore: news?.score ?? null,
        newsArticles: news?.articles ?? 0,
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
      watchlist: this.watchlist,
      fearGreedIndex: this.fearGreedIndex,
      prices: Object.fromEntries(currentPrices),
      bridgeSource: this.bridgeSource,
      tokenMetrics,
      newsCount: this.lastNewsCount,
      startedAt: this.startedAt,
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
    score: number | null;
    newsScore?: number | null;
    newsArticles?: number;
  }>;
  newsCount?: number;
  startedAt?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
