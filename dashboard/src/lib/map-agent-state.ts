import type { Track1Snapshot, LogEntry, WalletSnapshot } from "./agent-api";
import type { AgentState, Signal, Trade, ActivityItem } from "./mock-data";
import { roundNum } from "./utils";

/** Match backend MIN_POSITION_VALUE_USD — hide dust in the dashboard. */
const MIN_POSITION_USD = 1;

/** Native gas coin on BSC — tracked separately, never a tradeable position. */
const GAS_SYMBOL = "BNB";

/** Treated as cash (USDT-first agent). */
const CASH_SYMBOLS = new Set(["USDT", "USDC", "BUSD", "DAI", "FDUSD", "TUSD", "USD1"]);

const ON_CHAIN_TX_PATTERN = /^0x[a-fA-F0-9]{40,}$/;

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

function mapSignals(snap: Track1Snapshot): Signal[] {
  return snap.watchlist.map((symbol) => {
    const metrics = snap.tokenMetrics?.[symbol];
    const score = roundNum(metrics?.score ?? 0, 0);
    const strength = scoreToStrength(score);
    const price = snap.prices[symbol] ?? 0;
    const momentum = metrics?.momentum ?? 0;

    return {
      symbol,
      action: scoreToAction(strength),
      strength,
      score,
      rsi: roundNum(metrics?.rsi ?? 50, 0),
      macd: roundNum(metrics?.macd ?? 0, 1),
      confidence: roundNum(
        metrics?.confidence ?? Math.min(1, Math.abs(score) / 80 + 0.3),
        2
      ),
      price: roundNum(price, price < 1 ? 6 : 2),
      change24h: roundNum(momentum ?? 0, 2),
      volumeRatio: metrics?.volumeRatio ?? null,
      newsScore: metrics?.newsScore ?? null,
      newsArticles: metrics?.newsArticles ?? 0,
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

function mapTrades(snap: Track1Snapshot): Trade[] {
  return snap.trades
    .filter((t) => isConfirmedTrade(t, snap.mode))
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 20)
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

      return {
        id: t.orderId,
        timestamp: t.timestamp,
        symbol,
        side: (isBuy ? "buy" : "sell") as "buy" | "sell",
        amount: roundNum(tokenQty, 4),
        price: roundNum(price, price > 0 && price < 1 ? 6 : 2),
        total: roundNum(usdTotal, 2),
        txHash: t.txHash!,
        // Realized PnL is only meaningful on sells (closing a position).
        ...(!isBuy && t.realizedPnl !== undefined
          ? { pnl: roundNum(t.realizedPnl, 2) }
          : {}),
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
    tokens.push({ symbol, value, qty: p.remainQty, price: p.price });
    value24hAgo += priorValue(value, p.percentChange24h ?? 0);
  }

  const positionsValue = tokens.reduce((s, t) => s + t.value, 0);
  const nav = cashUsd + gasUsd + positionsValue;
  const dailyPnl = value24hAgo > 0 ? nav - value24hAgo : 0;
  const dailyPnlPct = value24hAgo > 0 ? (dailyPnl / value24hAgo) * 100 : 0;
  const prevBySymbol = new Map(state.positions.map((p) => [p.symbol, p]));

  const mapped = tokens
    .sort((a, b) => b.value - a.value)
    .map((t) => {
      const prev = prevBySymbol.get(t.symbol);
      const entryPrice =
        prev?.entryPrice && prev.entryPrice > 0 ? prev.entryPrice : t.price;
      const pnl = (t.price - entryPrice) * t.qty;
      const pnlPct = entryPrice > 0 ? ((t.price - entryPrice) / entryPrice) * 100 : 0;
      return {
        symbol: t.symbol,
        amount: roundNum(t.qty, 6),
        entryPrice: roundNum(entryPrice, 6),
        currentPrice: roundNum(t.price, 6),
        pnl: roundNum(pnl, 2),
        pnlPct: roundNum(pnlPct, 2),
        weight: nav > 0 ? roundNum((t.value / nav) * 100, 1) : 0,
      };
    });

  // Reconcile the equity curve with the real wallet NAV. The agent's internal
  // snapshots track its own bookkeeping value, but the headline Portfolio Value
  // is the on-chain scan (nav). Shift the whole curve by the delta so the latest
  // point equals Portfolio Value while preserving the curve's shape and PnL.
  const lastVal = state.equityCurve[state.equityCurve.length - 1]?.value;
  const offset = lastVal !== undefined ? nav - lastVal : 0;
  const equityCurve =
    Math.abs(offset) > 0.005
      ? state.equityCurve.map((p) => ({ ...p, value: roundNum(p.value + offset, 2) }))
      : state.equityCurve;

  return {
    ...state,
    portfolioValue: roundNum(nav, 2),
    cashBalance: roundNum(cashUsd, 2),
    gasReserveUsd: roundNum(gasUsd, 2),
    dailyPnl: roundNum(dailyPnl, 2),
    dailyPnlPct: roundNum(dailyPnlPct, 2),
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

  // Win rate from closed trades (sells that booked a realized PnL).
  const closedTrades = confirmedTrades.filter((t) => t.realizedPnl !== undefined);
  const wins = closedTrades.filter((t) => (t.realizedPnl ?? 0) >= 0).length;
  const winRate = closedTrades.length > 0
    ? roundNum((wins / closedTrades.length) * 100, 1)
    : 0;
  const realizedPnl = roundNum(
    snap.portfolio.realizedPnl
      ?? closedTrades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0),
    2
  );

  const base: AgentState = {
    status: snap.running ? "running" : "paused",
    mode: snap.mode as "live" | "paper",
    uptime,
    cycleCount: snap.cycleCount,
    portfolioValue: roundNum(snap.portfolio.totalValueUsd, 2),
    cashBalance: roundNum(snap.portfolio.cashUsd, 2),
    totalPnl: roundNum(snap.portfolio.totalPnl, 2),
    totalPnlPct: roundNum(snap.portfolio.totalPnlPct, 2),
    realizedPnl,
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
    winRate,
    fearGreedIndex: snap.fearGreedIndex ?? 50,
    positions: snap.portfolio.positions
      .filter((p) => p.amount * p.currentPrice >= MIN_POSITION_USD)
      .map((p) => ({
      symbol: p.symbol,
      amount: roundNum(p.amount, 4),
      entryPrice: roundNum(p.avgEntryPrice, 2),
      currentPrice: roundNum(p.currentPrice, 2),
      pnl: roundNum(p.unrealizedPnl, 2),
      pnlPct: roundNum(p.unrealizedPnlPct, 2),
      weight: roundNum(p.weight, 1),
    })),
    trades: mapTrades(snap),
    signals: mapSignals(snap),
    activity: mapActivity(logs),
    equityCurve: mapEquityCurve(snap),
    drawdownCurve: mapDrawdownCurve(snap),
  };

  if (snap.binancePositions && snap.binancePositions.length > 0) {
    return enrichStateWithWallet(base, snap.binancePositions);
  }
  return base;
}
