import type { Track1Snapshot, LogEntry, WalletSnapshot, AutonomousStatus } from "./agent-api";
import type { AgentState, Signal, Trade, ActivityItem } from "./mock-data";
import { mapActivityLogs } from "./brain-narrative";
import { roundNum, normalizeTokenIconUrl, roundTokenPrice, isPlausibleLivePrice } from "./utils";
import { isScannableToken } from "./tradable-filter";

/** Match backend MIN_POSITION_VALUE_USD — hide dust in the dashboard. */
const MIN_POSITION_USD = 1;

/** Native gas coin on BSC — tracked separately, never a tradeable position. */
const GAS_SYMBOL = "BNB";

/** Treated as cash (USDT-first agent). Campaign payment tokens except BNB. */
const CASH_SYMBOLS = new Set(["USDT", "USDC", "U", "USD1", "BUSD", "DAI", "FDUSD", "TUSD"]);

/** Funding-side tokens for buy/sell classification (matches agent portfolio). */
const FUNDING_TOKENS = new Set([...CASH_SYMBOLS, "BNB"]);

/** Buy = funding → asset. Sell = asset → funding. Skip USDT↔BNB and asset↔asset. */
function classifyAssetTrade(fromToken: string, toToken: string): "buy" | "sell" | null {
  const from = fromToken.toUpperCase();
  const to = toToken.toUpperCase();
  const fromFund = FUNDING_TOKENS.has(from);
  const toFund = FUNDING_TOKENS.has(to);
  if (fromFund && !toFund) return "buy";
  if (!fromFund && toFund) return "sell";
  return null;
}

const ON_CHAIN_TX_PATTERN = /^0x[a-fA-F0-9]{40,}$/;

function fallbackAutonomous(snap: Track1Snapshot): AutonomousStatus {
  const risk = snap.risk;
  const tradesToday = (risk.dailyTrades as number) ?? 0;
  const intervalSec = Math.round((snap.config.tradeIntervalMs ?? 300000) / 1000);
  const session = snap.session;
  return {
    phase: snap.running ? "idle" : "stopped",
    ready: Boolean(snap.running),
    headline: snap.running ? "Engine active" : "Engine stopped",
    tradesToday,
    tradesLast24h: snap.trades.filter((t) => t.success && t.timestamp >= Date.now() - 86400000).length,
    emergencyMode: Boolean(risk.emergencyMode),
    nextCycleInSec: null,
    lastCycleAt: null,
    lastCycleDurationSec: null,
    lastCycleTrades: 0,
    lastCycleQueued: 0,
    tradeIntervalSec: intervalSec,
    autoExitEnabled: Boolean(snap.config.autoExitEnabled),
    sessionPolicy: snap.config.sessionPolicy ?? session?.policy ?? "auto",
    session: session?.active ?? "overnight",
    sessionLabel: session?.label ?? "Overnight",
    nyTimeLabel: session?.nyTimeLabel ?? "—",
    failedSwapCooldowns: [],
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
  const entryUnknown = !(p.avgEntryPrice > 0);
  return {
    symbol: p.symbol,
    amount: roundNum(p.amount, 4),
    entryPrice: entryUnknown ? 0 : roundTokenPrice(p.avgEntryPrice),
    currentPrice: roundTokenPrice(p.currentPrice),
    pnl: entryUnknown ? 0 : roundNum(p.unrealizedPnl, 2),
    pnlPct: entryUnknown ? 0 : roundNum(p.unrealizedPnlPct, 2),
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
    entryUnknown,
  };
}

function parseTradeAmt(raw?: string): number {
  const n = parseFloat(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** FIFO realized PnL — only matched buy→sell of assets. Funding swaps ignored. */
function computeClosedTradeStats(
  trades: Track1Snapshot["trades"],
  mode: string
): {
  closedSells: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  costClosed: number;
  dailyRealizedPnl: number;
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
  let costClosed = 0;
  let dailyRealizedPnl = 0;
  const dayStart = Date.now() - 86_400_000;

  for (const t of confirmed) {
    const from = t.fromToken.toUpperCase();
    const to = t.toToken.toUpperCase();
    const price = t.priceAtExecution > 0 ? t.priceAtExecution : 0;
    const side = classifyAssetTrade(from, to);

    if (side === "buy") {
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

    if (side !== "sell") continue;

    const ledger = ledgers.get(from);
    if (!ledger || ledger.qty <= 0) continue;

    let soldQty = parseTradeAmt(t.fromAmount);
    if (soldQty <= 0 && price > 0) soldQty = parseTradeAmt(t.toAmount) / price;
    if (soldQty <= 0) continue;

    let proceeds = parseTradeAmt(t.toAmount);
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
    if (t.timestamp >= dayStart) dailyRealizedPnl += pnl;
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
  const userBlacklisted = new Set(
    (snap.userBlacklisted ?? []).map((s) => s.toUpperCase())
  );

  return snap.watchlist
    .filter((symbol) => {
      if (userBlacklisted.has(symbol.toUpperCase())) return true;
      const price = snap.prices[symbol] ?? 0;
      return isScannableToken(symbol, price, {
        excluded,
        minPriceUsd: minPrice,
      });
    })
    .map((symbol) => {
    const isBlocked = userBlacklisted.has(symbol.toUpperCase());
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
      stochRsi: metrics?.stochRsi ?? null,
      gapPct: metrics?.gapPct ?? null,
      orbBreakoutPct: metrics?.orbBreakoutPct ?? null,
      atrPct: metrics?.atrPct ?? null,
      session: metrics?.session,
      regime: metrics?.regime,
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
      blacklisted: isBlocked,
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
  const seen = new Map<string, Track1Snapshot["trades"][number]>();
  for (const t of snap.trades.filter((x) => isConfirmedTrade(x, snap.mode))) {
    const hash = t.txHash?.toLowerCase();
    const key =
      hash && ON_CHAIN_TX_PATTERN.test(hash)
        ? `hash:${hash}`
        : hash?.startsWith("binance-web3-")
          ? `binance:${hash}`
          : `order:${t.orderId}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, t);
      continue;
    }
    const prevChain = prev.orderId.startsWith("chain-");
    const nextChain = t.orderId.startsWith("chain-");
    if (prevChain && !nextChain) seen.set(key, t);
  }

  return [...seen.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .flatMap((t) => {
      const side = classifyAssetTrade(t.fromToken, t.toToken);
      if (!side) return [];
      const isBuy = side === "buy";
      const symbol = isBuy ? t.toToken : t.fromToken;
      const price = t.priceAtExecution || 0;
      const fromAmt = parseFloat(t.fromAmount) || 0;
      const toAmt = parseFloat(t.toAmount || "") || 0;

      const tokenQty = isBuy
        ? toAmt || (price > 0 ? fromAmt / price : 0)
        : fromAmt || (price > 0 ? toAmt / price : 0);
      const usdTotal = isBuy
        ? fromAmt || (price > 0 ? tokenQty * price : 0)
        : toAmt || (price > 0 ? tokenQty * price : 0);

      const inferredSellPnl = !isBuy ? sellPnls?.get(t.orderId) : undefined;
      const sellPnl = !isBuy ? (inferredSellPnl ?? t.realizedPnl) : undefined;

      return [{
        id: t.orderId,
        timestamp: t.timestamp,
        symbol,
        side,
        amount: roundNum(tokenQty, 4),
        price: roundNum(price, price > 0 && price < 1 ? 6 : 2),
        total: roundNum(usdTotal, 2),
        txHash: t.txHash!,
        ...(sellPnl !== undefined ? { pnl: roundNum(sellPnl, 2) } : {}),
      }];
    });
}

function mapActivity(logs: LogEntry[]): ActivityItem[] {
  return mapActivityLogs(logs);
}

function mapEquityCurve(snap: Track1Snapshot) {
  const snaps = snap.snapshots.length > 0 ? snap.snapshots : [snap.portfolio];
  const initial = snap.portfolio.initialNavUsd ?? 0;

  return snaps.map((s) => ({
    time: new Date(s.timestamp).toLocaleTimeString("en", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    value: roundNum(s.totalValueUsd, 2),
    pnl: initial > 0 ? roundNum(s.totalValueUsd - initial, 2) : 0,
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
  const tokens: Array<{
    symbol: string;
    value: number;
    qty: number;
    price: number;
    pct24h: number;
  }> = [];

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
      continue;
    }
    if (CASH_SYMBOLS.has(symbol)) {
      cashUsd += value;
      continue;
    }
    if (value < MIN_POSITION_USD) continue;
    if (!/^[A-Z0-9]{1,12}$/.test(symbol) && !prevBySymbol.has(symbol)) continue;
    tokens.push({
      symbol,
      value,
      qty: p.remainQty,
      price: p.price,
      pct24h: p.percentChange24h ?? 0,
    });
  }

  const positionsValue = tokens.reduce((s, t) => s + t.value, 0);
  const nav = cashUsd + gasUsd + positionsValue;

  const mapped = tokens
    .sort((a, b) => b.value - a.value)
    .map((t) => {
      const prev = prevBySymbol.get(t.symbol);
      const fromTrades = inferEntryFromDashboardTrades(state.trades, t.symbol);
      const fromAgent =
        prev?.entryPrice && prev.entryPrice > 0 ? prev.entryPrice : 0;
      const entryPrice = fromTrades || fromAgent || 0;
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
  const initialNav = state.initialNavUsd > 0 ? state.initialNavUsd : 0;
  const lastVal = state.equityCurve[state.equityCurve.length - 1]?.value;
  const offset = lastVal !== undefined ? nav - lastVal : 0;
  const equityCurve =
    Math.abs(offset) > 0.005
      ? state.equityCurve.map((p) => ({
          ...p,
          value: roundNum(p.value + offset, 2),
          pnl: initialNav > 0 ? roundNum(p.value + offset - initialNav, 2) : 0,
        }))
      : state.equityCurve.map((p) => ({
          ...p,
          pnl: initialNav > 0 ? roundNum(p.value - initialNav, 2) : 0,
        }));

  const unrealizedPnl = mapped.reduce(
    (sum, p) => sum + (p.entryUnknown ? 0 : p.pnl),
    0
  );
  const costOpen = mapped.reduce(
    (sum, p) => sum + (p.entryUnknown ? 0 : p.entryPrice * p.amount),
    0
  );
  const realizedPnl = roundNum(state.realizedPnl || 0, 2);
  const costClosed = state.trades
    .filter((t) => t.side === "sell" && t.pnl !== undefined)
    .reduce((s, t) => s + (t.total - (t.pnl ?? 0)), 0);
  const totalPnl = roundNum(realizedPnl + unrealizedPnl, 2);
  const tradedCost = costOpen + Math.max(0, costClosed);
  const totalPnlPct = tradedCost > 0 ? roundNum((totalPnl / tradedCost) * 100, 2) : 0;

  const dayStart = Date.now() - 86_400_000;
  const firstBuyAt = new Map<string, number>();
  for (const t of [...state.trades].sort((a, b) => a.timestamp - b.timestamp)) {
    if (t.side === "buy" && !firstBuyAt.has(t.symbol.toUpperCase())) {
      firstBuyAt.set(t.symbol.toUpperCase(), t.timestamp);
    }
  }
  const dailyRealized = state.trades
    .filter((t) => t.side === "sell" && t.pnl !== undefined && t.timestamp >= dayStart)
    .reduce((s, t) => s + (t.pnl ?? 0), 0);

  let dailyMtm = 0;
  let assetValue24hAgo = 0;
  for (const t of tokens) {
    const row = mapped.find((p) => p.symbol === t.symbol);
    if (!row || row.entryUnknown) continue;
    const openedAt = firstBuyAt.get(t.symbol) ?? 0;
    if (openedAt <= 0) continue;
    const mtm =
      openedAt >= dayStart
        ? (t.price - row.entryPrice) * t.qty
        : t.value - priorValue(t.value, t.pct24h);
    dailyMtm += mtm;
    assetValue24hAgo += t.value - mtm;
  }
  const dailyPnl = dailyRealized + dailyMtm;
  const dailyPnlPct =
    assetValue24hAgo > 0 ? (dailyPnl / assetValue24hAgo) * 100 : 0;

  return {
    ...state,
    portfolioValue: roundNum(nav, 2),
    cashBalance: roundNum(cashUsd, 2),
    gasReserveUsd: roundNum(gasUsd, 2),
    dailyPnl: roundNum(dailyPnl, 2),
    dailyPnlPct: roundNum(dailyPnlPct, 2),
    totalPnl,
    totalPnlPct,
    realizedPnl,
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
  const unrealizedPnl = snap.portfolio.positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const costOpen = snap.portfolio.positions.reduce(
    (s, p) => s + p.avgEntryPrice * p.amount,
    0
  );
  const assetPnl = closedStats.realizedPnl + unrealizedPnl;
  const tradedCost = costOpen + closedStats.costClosed;
  const assetPnlPct = tradedCost > 0 ? (assetPnl / tradedCost) * 100 : 0;
  const dailyPnl = closedStats.dailyRealizedPnl;
  const dailyPnlPct = tradedCost > 0 ? (dailyPnl / tradedCost) * 100 : 0;

  const base: AgentState = {
    status: snap.running ? "running" : "paused",
    mode: snap.mode as "live" | "paper",
    uptime,
    cycleCount: snap.cycleCount,
    portfolioValue: roundNum(snap.portfolio.totalValueUsd, 2),
    cashBalance: roundNum(snap.portfolio.cashUsd, 2),
    initialNavUsd: roundNum(snap.portfolio.initialNavUsd ?? 0, 2),
    totalPnl: roundNum(assetPnl, 2),
    totalPnlPct: roundNum(assetPnlPct, 2),
    realizedPnl: roundNum(closedStats.realizedPnl, 2),
    unrealizedPnl: roundNum(unrealizedPnl, 2),
    gasReserveUsd: roundNum(snap.portfolio.gasReserveUsd ?? 0, 2),
    dailyPnl: roundNum(dailyPnl, 2),
    dailyPnlPct: roundNum(dailyPnlPct, 2),
    maxDrawdownPct: roundNum(snap.portfolio.maxDrawdownPct, 2),
    currentDrawdownPct: drawdownPct,
    todayTrades: (risk.dailyTrades as number) ?? 0,
    totalTrades: confirmedTrades.length,
    closedTrades: closedStats.closedSells,
    winCount: closedStats.wins,
    lossCount: closedStats.losses,
    winRate: roundNum(closedStats.winRate, 1),
    autonomous: snap.autonomous ?? fallbackAutonomous(snap),
    maxDrawdownLimit: snap.config.maxDrawdownPct ?? 20,
    maxPositionsLimit:
      snap.config.maxPortfolioTokens ?? (risk.maxPositions as number) ?? 4,
    emergencyMode: Boolean(risk.emergencyMode ?? snap.autonomous?.emergencyMode),
    startedAt: snap.startedAt ?? null,
    sessionPolicy: snap.config.sessionPolicy ?? snap.session?.policy,
    sessionActive: snap.session?.active ?? snap.autonomous?.session,
    sessionLabel: snap.session?.label ?? snap.autonomous?.sessionLabel,
    nyTimeLabel: snap.session?.nyTimeLabel ?? snap.autonomous?.nyTimeLabel,
    positions: snap.portfolio.positions
      .filter((p) => p.amount * p.currentPrice >= MIN_POSITION_USD)
      .map(mapPosition),
    trades: mapTrades(snap, closedStats.sellPnlByOrderId),
    signals: mapSignals(snap),
    activity: mapActivity(logs),
    equityCurve: mapEquityCurve(snap),
    drawdownCurve: mapDrawdownCurve(snap),
    lastSignalRefreshAt: snap.lastSignalRefreshAt ?? null,
    signalRefreshSec: Math.round((snap.config.signalRefreshMs ?? 10_000) / 1000),
    stopLossPct: snap.config.stopLossPct ?? 8,
    takeProfitPct: snap.config.takeProfitPct ?? 15,
    trailingActivatePct: snap.config.trailingActivatePct,
    trailingGivebackPct: snap.config.trailingGivebackPct,
    autoExitEnabled: snap.config.autoExitEnabled,
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
