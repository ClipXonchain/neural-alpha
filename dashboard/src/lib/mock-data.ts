import type { AutonomousStatus } from "@/lib/agent-api";

export interface Position {
  symbol: string;
  amount: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPct: number;
  weight: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  distanceToStopPct?: number;
  distanceToTakeProfitPct?: number;
  peakPnlPct?: number;
  entryFromTrades?: boolean;
  /** Entry not yet resolved from trades — position still shown from wallet. */
  entryUnknown?: boolean;
}

export interface Trade {
  id: string;
  timestamp: number;
  symbol: string;
  side: "buy" | "sell";
  amount: number;
  price: number;
  total: number;
  txHash: string;
  pnl?: number;
}

export interface Signal {
  symbol: string;
  action: "buy" | "sell" | "hold";
  strength: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  score: number;
  rsi: number;
  macd: number | null;
  bbPosition?: number | null;
  vwapDev?: number | null;
  stochRsi?: number | null;
  gapPct?: number | null;
  orbBreakoutPct?: number | null;
  atrPct?: number | null;
  session?: string;
  regime?: string;
  confidence: number;
  price: number;
  change24h: number;
  newsScore?: number | null;
  newsArticles?: number;
  volumeRatio?: number | null;
  aiSummary?: string;
  aiVerdict?: "bullish" | "bearish" | "neutral" | "caution";
  aiAgrees?: boolean;
  icon?: string;
  livePrice?: number;
  liveChange24h?: number;
  livePriceUpdatedAt?: number | null;
  signalUpdatedAt?: number | null;
  usesRealOhlcv?: boolean;
  ohlcvReal?: boolean;
  blacklisted?: boolean;
}

export interface ActivityItem {
  id: string;
  timestamp: number;
  type: "brain" | "trade" | "signal" | "risk" | "info" | "error";
  message: string;
  detail?: string;
}

export interface AgentState {
  status: "running" | "paused" | "stopped";
  mode: "live" | "paper";
  uptime: number;
  cycleCount: number;
  portfolioValue: number;
  cashBalance: number;
  /** Competition / wallet baseline for lifetime PnL (USDT deposited). */
  initialNavUsd: number;
  /** Yesterday's UTC close NAV — Daily = current − this. */
  dayStartNavUsd?: number;
  totalPnl: number;
  totalPnlPct: number;
  realizedPnl: number;
  /** Open-position unrealized PnL (known entries only). */
  unrealizedPnl: number;
  gasReserveUsd: number;
  dailyPnl: number;
  dailyPnlPct: number;
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  todayTrades: number;
  totalTrades: number;
  /** Confirmed sells with resolved PnL. */
  closedTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  autonomous: AutonomousStatus;
  maxDrawdownLimit: number;
  maxPositionsLimit: number;
  emergencyMode: boolean;
  startedAt: number | null;
  sessionPolicy?: string;
  sessionActive?: string;
  sessionLabel?: string;
  nyTimeLabel?: string;
  positions: Position[];
  trades: Trade[];
  signals: Signal[];
  activity: ActivityItem[];
  equityCurve: Array<{ time: string; value: number; pnl: number; ts?: number }>;
  drawdownCurve: Array<{ time: string; drawdown: number }>;
  lastSignalRefreshAt?: number | null;
  signalRefreshSec?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingActivatePct?: number;
  trailingGivebackPct?: number;
  autoExitEnabled?: boolean;
  minTradablePriceUsd?: number;
  excludedTokens?: string[];
}

function generateEquityCurve(): Array<{ time: string; value: number; pnl: number }> {
  const points: Array<{ time: string; value: number; pnl: number }> = [];
  let value = 1000;
  const now = Date.now();
  for (let i = 168; i >= 0; i--) {
    const t = now - i * 3600000;
    const change = (Math.random() - 0.47) * 12;
    value = Math.max(800, value + change);
    points.push({
      time: new Date(t).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
      value: Math.round(value * 100) / 100,
      pnl: Math.round((value - 1000) * 100) / 100,
    });
  }
  return points;
}

function generateDrawdownCurve(): Array<{ time: string; drawdown: number }> {
  const points: Array<{ time: string; drawdown: number }> = [];
  let dd = 0;
  const now = Date.now();
  for (let i = 168; i >= 0; i--) {
    const t = now - i * 3600000;
    dd = Math.max(0, Math.min(25, dd + (Math.random() - 0.55) * 2));
    points.push({
      time: new Date(t).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
      drawdown: Math.round(dd * 100) / 100,
    });
  }
  return points;
}

const DEMO_AUTONOMOUS: AutonomousStatus = {
  phase: "idle",
  ready: true,
  headline: "LIVE · RTH",
  tradesToday: 4,
  tradesLast24h: 6,
  emergencyMode: false,
  nextCycleInSec: 240,
  lastCycleAt: Date.now() - 120_000,
  lastCycleDurationSec: 18,
  lastCycleTrades: 1,
  lastCycleQueued: 2,
  tradeIntervalSec: 300,
  autoExitEnabled: true,
  sessionPolicy: "auto",
  session: "rth",
  sessionLabel: "RTH",
  nyTimeLabel: "10:14 ET",
  failedSwapCooldowns: [],
};

export function generateMockState(): AgentState {
  const equityCurve = generateEquityCurve();
  const latestValue = equityCurve[equityCurve.length - 1].value;

  return {
    status: "running",
    mode: "paper",
    uptime: 3 * 86400 + 14 * 3600 + 22 * 60,
    cycleCount: 847,
    portfolioValue: latestValue,
    cashBalance: 412.35,
    initialNavUsd: 1000,
    dayStartNavUsd: latestValue - 23.47,
    totalPnl: latestValue - 1000,
    totalPnlPct: ((latestValue - 1000) / 1000) * 100,
    realizedPnl: 18.62,
    unrealizedPnl: 14.21,
    gasReserveUsd: 0,
    dailyPnl: 23.47,
    dailyPnlPct: 2.18,
    maxDrawdownPct: 8.4,
    currentDrawdownPct: 2.1,
    todayTrades: 4,
    totalTrades: 67,
    closedTrades: 34,
    winCount: 21,
    lossCount: 13,
    winRate: 61.2,
    autonomous: DEMO_AUTONOMOUS,
    maxDrawdownLimit: 20,
    maxPositionsLimit: 4,
    emergencyMode: false,
    startedAt: Date.now() - 3 * 3600000,
    sessionPolicy: "auto",
    sessionActive: "rth",
    sessionLabel: "RTH",
    nyTimeLabel: "10:14 ET",
    positions: [
      { symbol: "NVDAB", amount: 0.42, entryPrice: 178, currentPrice: 184, pnl: 2.52, pnlPct: 3.37, weight: 34.2 },
      { symbol: "AAPLB", amount: 1.1, entryPrice: 228, currentPrice: 232, pnl: 4.4, pnlPct: 1.75, weight: 28.1 },
      { symbol: "TSLAB", amount: 0.8, entryPrice: 348, currentPrice: 355, pnl: 5.6, pnlPct: 2.01, weight: 23.7 },
    ],
    trades: [
      { id: "t1", timestamp: Date.now() - 1200000, symbol: "NVDAB", side: "buy", amount: 0.42, price: 178, total: 74.76, txHash: "0x8a3f...d91e" },
      { id: "t2", timestamp: Date.now() - 3600000, symbol: "TSLAB", side: "sell", amount: 0.2, price: 350, total: 70, txHash: "0x1b7c...4f2a", pnl: 4.12 },
    ],
    signals: [
      { symbol: "NVDAB", action: "buy", strength: "buy", score: 28, rsi: 48, macd: 0.12, bbPosition: 62, vwapDev: 0.4, stochRsi: 58, gapPct: 0.35, orbBreakoutPct: 0.6, atrPct: 2.1, confidence: 0.72, price: 184, change24h: 1.4, volumeRatio: 1.6, session: "rth", regime: "risk_on", newsScore: 12, newsArticles: 2 },
      { symbol: "AAPLB", action: "hold", strength: "neutral", score: 8, rsi: 52, macd: 0.04, bbPosition: 50, vwapDev: 0.1, stochRsi: 44, gapPct: 0.1, orbBreakoutPct: 0, atrPct: 1.2, confidence: 0.55, price: 232, change24h: 0.4, volumeRatio: 0.9, session: "rth", regime: "neutral" },
      { symbol: "TSLAB", action: "sell", strength: "sell", score: -22, rsi: 71, macd: -0.08, bbPosition: 82, vwapDev: 1.1, stochRsi: 81, gapPct: 1.8, orbBreakoutPct: 1.2, atrPct: 3.4, confidence: 0.64, price: 355, change24h: 2.8, volumeRatio: 1.3, session: "rth", regime: "risk_on", newsScore: -8, newsArticles: 1 },
    ],
    activity: [
      { id: "a1", timestamp: Date.now() - 60000, type: "brain", message: "Bought NVDAB (~$74.76)." },
      { id: "a2", timestamp: Date.now() - 180000, type: "brain", message: "RTH scan — 6 signals. Best: NVDAB (buy, +28)." },
      { id: "a3", timestamp: Date.now() - 300000, type: "brain", message: "Close session: hold names still above VWAP." },
      { id: "a4", timestamp: Date.now() - 420000, type: "brain", message: "Cycle done — watching overnight gap. Status: idle." },
      { id: "a5", timestamp: Date.now() - 600000, type: "trade", message: "Sold TSLAB (~$70.00).", detail: "PnL: +$4.12 (+5.28%)" },
      { id: "a6", timestamp: Date.now() - 900000, type: "risk", message: "Passed on AAPLB — already holding — no duplicate buy." },
      { id: "a7", timestamp: Date.now() - 1200000, type: "signal", message: "Found 3 buy candidates. Top: NVDAB buy (28)." },
      { id: "a8", timestamp: Date.now() - 1800000, type: "error", message: "Trade failed on GMEB: swap quote timeout." },
    ],
    equityCurve,
    drawdownCurve: generateDrawdownCurve(),
    lastSignalRefreshAt: Date.now() - 4000,
    signalRefreshSec: 10,
  };
}

/** Empty shell when the agent API is unreachable — not fake demo portfolio data. */
export function generateOfflineState(): AgentState {
  return {
    status: "stopped",
    mode: "live",
    uptime: 0,
    cycleCount: 0,
    portfolioValue: 0,
    cashBalance: 0,
    initialNavUsd: 0,
    dayStartNavUsd: 0,
    totalPnl: 0,
    totalPnlPct: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    gasReserveUsd: 0,
    dailyPnl: 0,
    dailyPnlPct: 0,
    maxDrawdownPct: 0,
    currentDrawdownPct: 0,
    todayTrades: 0,
    totalTrades: 0,
    closedTrades: 0,
    winCount: 0,
    lossCount: 0,
    winRate: 0,
    autonomous: {
      phase: "stopped",
      ready: false,
      headline: "Agent offline",
      blockReason: "Cannot reach agent API",
      tradesToday: 0,
      tradesLast24h: 0,
      emergencyMode: false,
      nextCycleInSec: null,
      lastCycleAt: null,
      lastCycleDurationSec: null,
      lastCycleTrades: 0,
      lastCycleQueued: 0,
      tradeIntervalSec: 0,
      autoExitEnabled: false,
      sessionPolicy: "auto",
      session: "overnight",
      sessionLabel: "Overnight",
      nyTimeLabel: "—",
      failedSwapCooldowns: [],
    },
    maxDrawdownLimit: 20,
    maxPositionsLimit: 4,
    emergencyMode: false,
    startedAt: null,
    sessionPolicy: "auto",
    sessionActive: "overnight",
    sessionLabel: "Overnight",
    nyTimeLabel: "—",
    positions: [],
    trades: [],
    signals: [],
    activity: [],
    equityCurve: [],
    drawdownCurve: [],
  };
}
