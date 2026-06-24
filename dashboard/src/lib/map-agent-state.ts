import type { Track1Snapshot, LogEntry, WalletSnapshot, AutonomousStatus } from "./agent-api";
import type { AgentState, Signal, Trade, ActivityItem } from "./mock-data";
import { roundNum, normalizeTokenIconUrl, roundTokenPrice, isPlausibleLivePrice } from "./utils";
import { isScannableToken } from "./tradable-filter";

/** Match backend MIN_POSITION_VALUE_USD — hide dust in the dashboard. */
const MIN_POSITION_USD = 1;

/** Native gas coin on BSC — tracked separately, never a tradeable position. */
const GAS_SYMBOL = "BNB";

/** Treated as cash (USDT-first agent). */
const CASH_SYMBOLS = new Set(["USDT", "USDC", "BUSD", "DAI", "FDUSD", "TUSD", "USD1"]);

/** Funding-side tokens for buy/sell classification (matches agent portfolio). */
const FUNDING_TOKENS = new Set([...CASH_SYMBOLS, "BNB"]);

const ON_CHAIN_TX_PATTERN = /^0x[a-fA-F0-9]{40,}$/;

function fallbackAutonomous(snap: Track1Snapshot): AutonomousStatus {
  const risk = snap.risk;
  const tradesToday = (risk.dailyTrades as number) ?? 0;
  const maxTrades = snap.config.maxDailyTrades ?? 10;
  const intervalSec = Math.round((snap.config.tradeIntervalMs ?? 3600000) / 1000);
  return {
    phase: snap.running ? "idle" : "stopped",
    ready: Boolean(snap.running),
    headline: snap.running ? "Autonomous engine active" : "Autonomous engine stopped",
    tradesToday,
    maxTradesToday: maxTrades,
    tradesLast24h: snap.trades.filter((t) => t.success && t.timestamp >= Date.now() - 86400000).length,
    txsToday: 0,
    maxTxsToday: 10,
    swapsRemainingToday: 0,
    emergencyMode: Boolean(risk.emergencyMode),
    startupCooldownSec: snap.startupCooldownRemainingMs
      ? Math.ceil(snap.startupCooldownRemainingMs / 1000)
      : 0,
    nextCycleInSec: null,
    lastCycleAt: null,
    lastCycleDurationSec: null,
    lastCycleTrades: 0,
    lastCycleQueued: 0,
    tradeIntervalSec: intervalSec,
    maxPerCycle: 1,
    autoExitEnabled: false,
    strategy: snap.config.strategy ?? "medium",
    failedSwapCooldowns: [],
    competitionNudge: tradesToday === 0,
  };
}

function isConfirmedTrade(
  t: Track1Snapshot["trades"][number],
  mode: string
): boolean {
  if (!t.success || !t.txHash) return false;
  if (t.txHash.startsWith("binance-web3-")) return true;
  if (mode === "paper") {
    return t.txHash.startsWith("paper-") || ON_CHAIN_TX_PATTERN.test(t.txHash);
  }
  return ON_CHAIN_TX_PATTERN.test(t.txHash);
}

function scoreToStrength(score: number): Signal["strength"] {
  if (score >= 50) return "strong_buy";
  if (score >= 20) return "buy";
  if (score <= -50) return "strong_sell";
  if (score <= -20) return "sell";
  return "neutral";
}

function scoreToAction(strength: Signal["strength"]): Signal["action"] {
  if (strength === "strong_buy" || strength === "buy") return "buy";
  if (strength === "strong_sell" || strength === "sell") return "sell";
  return "hold";
}

function mapPosition(
  p: Track1Snapshot["portfolio"]["positions"][number]
): AgentState["positions"][number] {
  return {
    symbol: p.symbol,
    amount: roundNum(p.amount, 4),
    entryPrice: roundTokenPrice(p.avgEntryPrice),
    currentPrice: roundTokenPrice(p.currentPrice),
    pnl: roundNum(p.unrealizedPnl, 2),
    pnlPct: roundNum(p.unrealizedPnlPct, 2),
    weight: roundNum(p.weight, 1),
    ...(p.stopLossPrice != null
      ? { stopLossPrice: roundTokenPrice(p.stopLossPrice) }
      : {}),
    ...(p.takeProfitPrice != null
      ? { takeProfitPrice: roundTokenPrice(p.takeProfitPrice) }
      : {}),
    ...(p.distanceToStopPct != null
      ? { distanceToStopPct: roundNum(p.distanceToStopPct, 1) }
      : {}),
    ...(p.distanceToTakeProfitPct != null
      ? { distanceToTakeProfitPct: roundNum(p.distanceToTakeProfitPct, 1) }
      : {}),
    ...(p.peakPnlPct != null ? { peakPnlPct: roundNum(p.peakPnlPct, 1) } : {}),
    ...(p.entryFromTrades ? { entryFromTrades: true } : {}),
  };
}

function parseTradeAmt(raw?: string): number {
  const n = parseFloat(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Win rate from closed sells — replays cost basis when realizedPnl is missing. */
function computeClosedTradeStats(
  trades: Track1Snapshot["trades"],
  mode: string
): {
  closedSells: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  sellPnlByOrderId: Map<string, number>;
} {
  const confirmed = trades
    .filter((t) => isConfirmedTrade(t, mode))
    .sort((a, b) => a.timestamp - b.timestamp);

  const ledgers = new Map<string, { qty: number; cost: number }>();
  const sellPnlByOrderId = new Map<string, number>();
  let wins = 0;
  let losses = 0;
  let closedSells = 0;
  let realizedPnl = 0;

  for (const t of confirmed) {
    const from = t.fromToken.toUpperCase();
    const to = t.toToken.toUpperCase();
    const price = t.priceAtExecution > 0 ? t.priceAtExecution : 0;
    const isBuy = FUNDING_TOKENS.has(from) && !FUNDING_TOKENS.has(to);
    const isSell = !FUNDING_TOKENS.has(from) && FUNDING_TOKENS.has(to);

    if (isBuy) {
      const sym = to;
      let tokenQty = parseTradeAmt(t.toAmount);
      if (tokenQty <= 0 && price > 0) tokenQty = parseTradeAmt(t.fromAmount) / price;
      if (tokenQty <= 0 || price <= 0) continue;
      const cur = ledgers.get(sym) ?? { qty: 0, cost: 0 };
      cur.cost += price * tokenQty;
      cur.qty += tokenQty;
      ledgers.set(sym, cur);
      continue;
    }

    if (!isSell) continue;

    const sym = from;
    let soldQty = parseTradeAmt(t.fromAmount);
    if (soldQty <= 0 && price > 0) soldQty = parseTradeAmt(t.toAmount) / price;
    if (soldQty <= 0) continue;

    let proceeds = parseTradeAmt(t.toAmount);
    if (proceeds <= 0 && price > 0) proceeds = soldQty * price;

    let pnl = t.realizedPnl;
    const ledger = ledgers.get(sym);
    if (pnl === undefined) {
      if (!ledger || ledger.qty <= 0) continue;
      const avgEntry = ledger.cost / ledger.qty;
      const sold = Math.min(soldQty, ledger.qty);
      pnl = proceeds - avgEntry * sold;
    }

    if (ledger && ledger.qty > 0) {
      const avg = ledger.cost / ledger.qty;
      const sold = Math.min(soldQty, ledger.qty);
      ledger.qty -= sold;
      ledger.cost = ledger.qty > 0 ? avg * ledger.qty : 0;
      if (ledger.qty <= 1e-12) ledgers.delete(sym);
      else ledgers.set(sym, ledger);
    }

    closedSells++;
    realizedPnl += pnl;
    sellPnlByOrderId.set(t.orderId, pnl);
    if (pnl >= 0) wins++;
    else losses++;
  }

  const winRate = closedSells > 0 ? (wins / closedSells) * 100 : 0;
  return { closedSells, wins, losses, winRate, realizedPnl, sellPnlByOrderId };
}

function inferEntryFromDashboardTrades(
  trades: Trade[],
  symbol: string
): number | undefined {
  const sym = symbol.toUpperCase();
  let qty = 0;
  let cost = 0;
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  for (const t of sorted) {
    if (t.symbol.toUpperCase() !== sym) continue;
    if (t.side === "buy" && t.price > 0 && t.amount > 0) {
      cost += t.price * t.amount;
      qty += t.amount;
    } else if (t.side === "sell" && t.amount > 0 && qty > 0) {
      const avg = cost / qty;
      const sold = Math.min(t.amount, qty);
      qty -= sold;
      cost = avg * qty;
    }
  }
  if (qty <= 0 || cost <= 0) return undefined;
  return cost / qty;
}

function exitLevelsFromEntry(
  entry: number,
  current: number,
  stopLossPct: number,
  takeProfitPct: number,
  peakPnlPct?: number
): {
  stopLossPrice: number;
  takeProfitPrice: number;
  distanceToStopPct: number;
  distanceToTakeProfitPct: number;
  pnlPct: number;
  peakPnlPct?: number;
} | null {
  if (entry <= 0) return null;
  const pnlPct = ((current - entry) / entry) * 100;
  return {
    stopLossPrice: roundTokenPrice(entry * (1 - stopLossPct / 100)),
    takeProfitPrice: roundTokenPrice(entry * (1 + takeProfitPct / 100)),
    distanceToStopPct: roundNum(pnlPct + stopLossPct, 1),
    distanceToTakeProfitPct: roundNum(takeProfitPct - pnlPct, 1),
    pnlPct: roundNum(pnlPct, 2),
    ...(peakPnlPct != null ? { peakPnlPct: roundNum(peakPnlPct, 1) } : {}),
  };
}

function mapSignals(snap: Track1Snapshot): Signal[] {
  const signalUpdatedAt = snap.lastSignalRefreshAt ?? null;
  const excluded = snap.config.excludedTokens;
  const minPrice = snap.config.minTradablePriceUsd;

  return snap.watchlist
    .filter((symbol) => {
      const price = snap.prices[symbol] ?? 0;
      return isScannableToken(symbol, price, {
        excluded,
        minPriceUsd: minPrice,
      });
    })
    .map((symbol) => {
    const metrics = snap.tokenMetrics?.[symbol];
    const score = roundNum(metrics?.score ?? 0, 0);
    const strength = scoreToStrength(score);
    const live = snap.livePrices?.[symbol];
    const agentPrice = snap.prices[symbol] ?? 0;
    const momentum = metrics?.momentum ?? 0;
    const liveRaw = live?.price;
    const liveOk =
      liveRaw != null &&
      liveRaw > 0 &&
      isPlausibleLivePrice(agentPrice > 0 ? agentPrice : undefined, liveRaw);

    return {
      symbol,
      action: scoreToAction(strength),
      strength,
      score,
      rsi: roundNum(metrics?.rsi ?? 50, 0),
      macd: metrics?.macd != null ? roundNum(metrics.macd, 2) : null,
      bbPosition: metrics?.bbPosition ?? null,
      vwapDev: metrics?.vwapDev ?? null,
      confidence: roundNum(
        metrics?.confidence ?? Math.min(1, Math.abs(score) / 80 + 0.3),
        2
      ),
      price: roundTokenPrice(agentPrice),
      change24h: roundNum(momentum, 2),
      volumeRatio: metrics?.volumeRatio ?? null,
      newsScore: metrics?.newsScore ?? null,
      newsArticles: metrics?.newsArticles ?? 0,
      icon: normalizeTokenIconUrl(snap.tokenIcons?.[symbol]),
      livePrice: liveOk ? roundTokenPrice(liveRaw!) : undefined,
      liveChange24h: liveOk && live?.change24hPct != null ? roundNum(live.change24hPct, 2) : undefined,
      livePriceUpdatedAt: liveOk ? (live?.updatedAt ?? null) : null,
      signalUpdatedAt,
      ohlcvReal: metrics?.ohlcvReal ?? false,
      ...(metrics?.aiSummary
        ? {
            aiSummary: metrics.aiSummary,
            aiVerdict: metrics.aiVerdict as Signal["aiVerdict"],
            aiAgrees: metrics.aiAgrees,
          }
        : {}),
    };
  });
}

function mapTrades(
  snap: Track1Snapshot,
  sellPnls?: Map<string, number>
): Trade[] {
  return snap.trades
    .filter((t) => isConfirmedTrade(t, snap.mode))
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((t) => {
      const isBuy = ["USDT", "BNB", snap.config.baseCurrency]
        .includes(t.fromToken.toUpperCase());
      const symbol = isBuy ? t.toToken : t.fromToken;
      const price = t.priceAtExecution || 0;
      const fromAmt = parseFloat(t.fromAmount) || 0;
      const toAmt = parseFloat(t.toAmount || "") || 0;

      // Buys: fromAmount = USDT spent, toAmount = tokens received.
      // Sells: fromAmount = tokens sold, toAmount = USDT received.
      const tokenQty = isBuy
        ? toAmt || (price > 0 ? fromAmt / price : 0)
        : fromAmt || (price > 0 ? toAmt / price : 0);
      const usdTotal = isBuy
        ? fromAmt || (price > 0 ? tokenQty * price : 0)
        : toAmt || (price > 0 ? tokenQty * price : 0);

      const inferredSellPnl = !isBuy ? sellPnls?.get(t.orderId) : undefined;
      const sellPnl = !isBuy
        ? (t.realizedPnl ?? inferredSellPnl)
        : undefined;

      return {
        id:
          t.txHash && ON_CHAIN_TX_PATTERN.test(t.txHash) ? t.txHash : t.orderId,
        timestamp: t.timestamp,
        symbol,
        side: (isBuy ? "buy" : "sell") as "buy" | "sell",
        amount: roundNum(tokenQty, 4),
        price: roundNum(price, price > 0 && price < 1 ? 6 : 2),
        total: roundNum(usdTotal, 2),
        txHash: t.txHash!,
        ...(sellPnl !== undefined ? { pnl: roundNum(sellPnl, 2) } : {}),
      };
    });
}

function mapActivity(logs: LogEntry[]): ActivityItem[] {
  return logs
    .slice(-30)
    .reverse()
    .map((log, i) => ({
      id: `${log.timestamp}-${i}`,
      timestamp: new Date(log.timestamp).getTime(),
      type: (["trade", "signal", "risk", "error"].includes(log.level)
        ? log.level
        : "info") as ActivityItem["type"],
      message: log.event,
      detail: log.data ? JSON.stringify(log.data) : log.txHash,
    }));
}

function mapEquityCurve(snap: Track1Snapshot) {
  const snaps = snap.snapshots.length > 0 ? snap.snapshots : [snap.portfolio];
  const initial = snap.portfolio.totalValueUsd - snap.portfolio.totalPnl;

  return snaps.map((s) => ({
    time: new Date(s.timestamp).toLocaleTimeString("en", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    value: roundNum(s.totalValueUsd, 2),
    pnl: roundNum(s.totalValueUsd - initial, 2),
  }));
}

function mapDrawdownCurve(snap: Track1Snapshot) {
  const snaps = snap.snapshots.length > 0 ? snap.snapshots : [snap.portfolio];
  return snaps.map((s) => ({
    time: new Date(s.timestamp).toLocaleTimeString("en", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    drawdown: roundNum(s.maxDrawdownPct, 2),
  }));
}

/**
 * Overlay the live Binance Web3 wallet scan onto the dashboard state so
 * portfolio value, positions, cash and gas reflect real on-chain holdings —
 * including tokens the agent has no internal price feed for (e.g. TWT, which
 * would otherwise show currentPrice 0 and get dropped).
 *
 * Binance Web3 provides an authoritative USD price for every token, so we use
 * it as the source of truth for allocation while preserving the agent's entry
 * price / PnL where a matching position already exists.
 */
export function enrichStateWithWallet(
  state: AgentState,
  positions?: WalletSnapshot["binancePositions"]
): AgentState {
  if (!positions || positions.length === 0) return state;

  let gasUsd = 0;
  let cashUsd = 0;
  // NAV 24h ago, reconstructed from each holding's 24h price change, so we can
  // derive a real, dynamic daily (24h) PnL for the live wallet.
  let value24hAgo = 0;
  const tokens: Array<{ symbol: string; value: number; qty: number; price: number }> = [];

  const priorValue = (value: number, pct: number) => {
    const factor = 1 + pct / 100;
    return factor > 0 ? value / factor : value;
  };
  const prevBySymbol = new Map(state.positions.map((p) => [p.symbol, p]));

  for (const p of positions) {
    const symbol = p.symbol.toUpperCase();
    const value = p.valueUsd > 0 ? p.valueUsd : p.remainQty * p.price;
    if (symbol === GAS_SYMBOL) {
      gasUsd += value;
      value24hAgo += priorValue(value, p.percentChange24h ?? 0);
      continue;
    }
    if (CASH_SYMBOLS.has(symbol)) {
      cashUsd += value;
      value24hAgo += value; // stables ≈ flat
      continue;
    }
    if (value < MIN_POSITION_USD) continue; // skip dust / airdrop spam
    // Competition-style tickers only (hides Chinese spam/airdrop rows in Open Positions)
    if (!/^[A-Z0-9]{1,12}$/.test(symbol) && !prevBySymbol.has(symbol)) continue;
    tokens.push({ symbol, value, qty: p.remainQty, price: p.price });
    value24hAgo += priorValue(value, p.percentChange24h ?? 0);
  }

  const positionsValue = tokens.reduce((s, t) => s + t.value, 0);
  const nav = cashUsd + gasUsd + positionsValue;
  const dailyPnl = value24hAgo > 0 ? nav - value24hAgo : 0;
  const dailyPnlPct = value24hAgo > 0 ? (dailyPnl / value24hAgo) * 100 : 0;

  const mapped = tokens
    .sort((a, b) => b.value - a.value)
    .map((t) => {
      const prev = prevBySymbol.get(t.symbol);
      const fromTrades = inferEntryFromDashboardTrades(state.trades, t.symbol);
      const entryPrice =
        (prev?.entryPrice && prev.entryPrice > 0 ? prev.entryPrice : 0) ||
        fromTrades ||
        0;
      const entryUnknown = entryPrice <= 0;

      const effectiveEntry = entryUnknown ? t.price : entryPrice;
      const exits = exitLevelsFromEntry(
        effectiveEntry,
        t.price,
        state.stopLossPct ?? 8,
        state.takeProfitPct ?? 15,
        prev?.peakPnlPct
      );

      return {
        symbol: t.symbol,
        amount: roundNum(t.qty, 6),
        entryPrice: entryUnknown ? 0 : roundTokenPrice(entryPrice),
        currentPrice: roundTokenPrice(t.price),
        pnl: entryUnknown ? 0 : roundNum((t.price - entryPrice) * t.qty, 2),
        pnlPct: entryUnknown ? 0 : (exits?.pnlPct ?? 0),
        weight: nav > 0 ? roundNum((t.value / nav) * 100, 1) : 0,
        ...(exits && !entryUnknown
          ? {
              stopLossPrice: exits.stopLossPrice,
              takeProfitPrice: exits.takeProfitPrice,
              distanceToStopPct: exits.distanceToStopPct,
              distanceToTakeProfitPct: exits.distanceToTakeProfitPct,
              peakPnlPct: exits.peakPnlPct,
            }
          : {}),
        entryFromTrades: !entryUnknown && (prev?.entryFromTrades || fromTrades != null),
        entryUnknown,
      };
    });

  // Reconcile the equity curve with the real wallet NAV. The agent's internal
  // snapshots track its own bookkeeping value, but the headline Portfolio Value
  // is the on-chain scan (nav). Shift the whole curve by the delta so the latest
  // point equals Portfolio Value while preserving the curve's shape and PnL.
  const initialNav =
    state.initialNavUsd > 0
      ? state.initialNavUsd
      : Math.max(0, state.portfolioValue - state.totalPnl);
  const lastVal = state.equityCurve[state.equityCurve.length - 1]?.value;
  const offset = lastVal !== undefined ? nav - lastVal : 0;
  const equityCurve =
    Math.abs(offset) > 0.005
      ? state.equityCurve.map((p) => ({
          ...p,
          value: roundNum(p.value + offset, 2),
          pnl: roundNum(p.value + offset - initialNav, 2),
        }))
      : state.equityCurve.map((p) => ({
          ...p,
          pnl: roundNum(p.value - initialNav, 2),
        }));

  const unrealizedPnl = mapped.reduce(
    (sum, p) => sum + (p.entryUnknown ? 0 : p.pnl),
    0
  );
  const totalPnl = roundNum(nav - initialNav, 2);
  const totalPnlPct =
    initialNav > 0 ? roundNum((totalPnl / initialNav) * 100, 2) : 0;

  return {
    ...state,
    portfolioValue: roundNum(nav, 2),
    cashBalance: roundNum(cashUsd, 2),
    gasReserveUsd: roundNum(gasUsd, 2),
    dailyPnl: roundNum(dailyPnl, 2),
    dailyPnlPct: roundNum(dailyPnlPct, 2),
    totalPnl,
    totalPnlPct,
    realizedPnl: roundNum(state.realizedPnl || 0, 2),
    unrealizedPnl: roundNum(unrealizedPnl, 2),
    initialNavUsd: roundNum(initialNav, 2),
    positions: mapped,
    equityCurve,
  };
}

export function mapTrack1ToDashboard(
  snap: Track1Snapshot,
  logs: LogEntry[] = []
): AgentState {
  const risk = snap.risk;
  const drawdownPct = roundNum(
    (risk.drawdownPct as number) ?? snap.portfolio.maxDrawdownPct,
    2
  );
  const uptime = snap.startedAt
    ? Math.floor((Date.now() - snap.startedAt) / 1000)
    : 0;

  const confirmedTrades = snap.trades.filter((t) => isConfirmedTrade(t, snap.mode));
  const closedStats = computeClosedTradeStats(snap.trades, snap.mode);

  const base: AgentState = {
    status: snap.running ? "running" : "paused",
    mode: snap.mode as "live" | "paper",
    uptime,
    cycleCount: snap.cycleCount,
    portfolioValue: roundNum(snap.portfolio.totalValueUsd, 2),
    cashBalance: roundNum(snap.portfolio.cashUsd, 2),
    initialNavUsd: roundNum(
      snap.portfolio.initialNavUsd
        ?? Math.max(0, snap.portfolio.totalValueUsd - snap.portfolio.totalPnl),
      2
    ),
    totalPnl: roundNum(snap.portfolio.totalPnl, 2),
    totalPnlPct: roundNum(snap.portfolio.totalPnlPct, 2),
    realizedPnl: roundNum(
      closedStats.realizedPnl || snap.portfolio.realizedPnl || 0,
      2
    ),
    unrealizedPnl: roundNum(
      snap.portfolio.positions.reduce((s, p) => s + p.unrealizedPnl, 0),
      2
    ),
    gasReserveUsd: roundNum(snap.portfolio.gasReserveUsd ?? 0, 2),
    dailyPnl: roundNum(snap.portfolio.dailyPnl, 2),
    dailyPnlPct: roundNum(
      (snap.portfolio.dailyPnl / Math.max(snap.portfolio.totalValueUsd, 1)) * 100,
      2
    ),
    maxDrawdownPct: roundNum(snap.portfolio.maxDrawdownPct, 2),
    currentDrawdownPct: drawdownPct,
    todayTrades: (risk.dailyTrades as number) ?? 0,
    totalTrades: confirmedTrades.length,
    closedTrades: closedStats.closedSells,
    winCount: closedStats.wins,
    lossCount: closedStats.losses,
    winRate: roundNum(closedStats.winRate, 1),
    fearGreedIndex: snap.fearGreedIndex ?? null,
    autonomous: snap.autonomous ?? fallbackAutonomous(snap),
    maxDrawdownLimit: snap.config.maxDrawdownPct ?? 20,
    maxDailyTradesLimit:
      snap.config.maxDailyTrades ?? (risk.maxDailyTrades as number) ?? 10,
    maxPositionsLimit:
      snap.config.maxPortfolioTokens ?? (risk.maxPositions as number) ?? 4,
    emergencyMode: Boolean(risk.emergencyMode ?? snap.autonomous?.emergencyMode),
    startedAt: snap.startedAt ?? null,
    startupCooldownMs: snap.config.startupCooldownMs ?? 120_000,
    positions: snap.portfolio.positions
      .filter((p) => p.amount * p.currentPrice >= MIN_POSITION_USD)
      .map(mapPosition),
    trades: mapTrades(snap, closedStats.sellPnlByOrderId),
    signals: mapSignals(snap),
    activity: mapActivity(logs),
    equityCurve: mapEquityCurve(snap),
    drawdownCurve: mapDrawdownCurve(snap),
    lastSignalRefreshAt: snap.lastSignalRefreshAt ?? null,
    signalRefreshSec: Math.round((snap.config.signalRefreshMs ?? 300_000) / 1000),
    stopLossPct: snap.config.stopLossPct ?? 8,
    takeProfitPct: snap.config.takeProfitPct ?? 15,
    minTradablePriceUsd: snap.config.minTradablePriceUsd ?? 0.01,
    excludedTokens: snap.config.excludedTokens,
  };

  if (snap.binancePositions && snap.binancePositions.length > 0) {
    return enrichStateWithWallet(base, snap.binancePositions);
  }
  return base;
}

/** Overlay Binance Web3 wallet poll prices onto signal rows (30s refresh). */
export function mergeWalletLiveIntoSignals(
  state: AgentState,
  positions?: WalletSnapshot["binancePositions"]
): AgentState {
  if (!positions?.length) return state;
  const bySymbol = new Map(positions.map((p) => [p.symbol.toUpperCase(), p]));
  return {
    ...state,
    signals: state.signals.map((s) => {
      const p = bySymbol.get(s.symbol);
      if (!p || p.price <= 0) return s;
      const ref = s.price > 0 ? s.price : undefined;
      if (!isPlausibleLivePrice(ref, p.price)) return s;
      return {
        ...s,
        livePrice: p.price,
        liveChange24h: p.percentChange24h,
        livePriceUpdatedAt: Date.now(),
        icon: normalizeTokenIconUrl(s.icon) || normalizeTokenIconUrl(p.icon),
      };
    }),
  };
}
