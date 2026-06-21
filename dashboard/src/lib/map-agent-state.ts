import type { Track1Snapshot, LogEntry } from "./agent-api";
import type { AgentState, Signal, Trade, ActivityItem } from "./mock-data";
import { roundNum } from "./utils";

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
      rsi: roundNum(50 + score * 0.4, 0),
      macd: roundNum((metrics?.momentum ?? 0) / 10, 1),
      confidence: roundNum(Math.min(1, Math.abs(score) / 80 + 0.3), 2),
      price: roundNum(price, price < 1 ? 6 : 2),
      change24h: roundNum(momentum ?? 0, 2),
      newsScore: metrics?.newsScore ?? null,
      newsArticles: metrics?.newsArticles ?? 0,
    };
  });
}

function mapTrades(snap: Track1Snapshot): Trade[] {
  return snap.trades
    .filter((t) => t.success)
    .slice(-20)
    .reverse()
    .map((t) => {
      const isBuy = t.fromToken === snap.config.baseCurrency || t.fromToken === "USDT";
      const symbol = isBuy ? t.toToken : t.fromToken;
      const amount = parseFloat(t.toAmount || t.fromAmount) || 0;
      const total = parseFloat(t.fromAmount) || 0;

      return {
        id: t.orderId,
        timestamp: t.timestamp,
        symbol,
        side: isBuy ? "buy" : "sell",
        amount: roundNum(amount, 4),
        price: roundNum(t.priceAtExecution, 2),
        total: roundNum(total, 2),
        txHash: t.txHash || "pending",
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

export function mapTrack1ToDashboard(
  snap: Track1Snapshot,
  logs: LogEntry[] = []
): AgentState {
  const risk = snap.risk;
  const drawdownPct = roundNum(
    (risk.drawdownPct as number) ?? snap.portfolio.maxDrawdownPct,
    2
  );
  const emergencyMode = Boolean(risk.emergencyMode);

  const uptime = snap.startedAt
    ? Math.floor((Date.now() - snap.startedAt) / 1000)
    : 0;

  return {
    status: emergencyMode
      ? "emergency"
      : snap.running
        ? "running"
        : "paused",
    mode: snap.mode as "live" | "paper",
    uptime,
    cycleCount: snap.cycleCount,
    portfolioValue: roundNum(snap.portfolio.totalValueUsd, 2),
    cashBalance: roundNum(snap.portfolio.cashUsd, 2),
    totalPnl: roundNum(snap.portfolio.totalPnl, 2),
    totalPnlPct: roundNum(snap.portfolio.totalPnlPct, 2),
    dailyPnl: roundNum(snap.portfolio.dailyPnl, 2),
    dailyPnlPct: roundNum(
      (snap.portfolio.dailyPnl / Math.max(snap.portfolio.totalValueUsd, 1)) * 100,
      2
    ),
    maxDrawdownPct: roundNum(snap.portfolio.maxDrawdownPct, 2),
    currentDrawdownPct: drawdownPct,
    todayTrades: (risk.dailyTrades as number) ?? 0,
    totalTrades: snap.portfolio.tradeCount,
    winRate: 58,
    fearGreedIndex: snap.fearGreedIndex ?? 50,
    positions: snap.portfolio.positions.map((p) => ({
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
}
