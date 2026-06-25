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
  /** Competition / wallet baseline for lifetime PnL. */
  initialNavUsd: number;
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
  fearGreedIndex: number | null;
  autonomous: AutonomousStatus;
  maxDrawdownLimit: number;
  maxDailyTradesLimit: number;
  maxPositionsLimit: number;
  emergencyMode: boolean;
  startedAt: number | null;
  startupCooldownMs: number;
  positions: Position[];
  trades: Trade[];
  signals: Signal[];
  activity: ActivityItem[];
  equityCurve: Array<{ time: string; value: number; pnl: number }>;
  drawdownCurve: Array<{ time: string; drawdown: number }>;
  lastSignalRefreshAt?: number | null;
  signalRefreshSec?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
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
  headline: "Autonomous — next scan in 28m 14s",
  tradesToday: 4,
  maxTradesToday: 10,
  tradesLast24h: 6,
  txsToday: 8,
  maxTxsToday: 10,
  swapsRemainingToday: 1,
  emergencyMode: false,
  startupCooldownSec: 0,
  nextCycleInSec: 1694,
  lastCycleAt: Date.now() - 120_000,
  lastCycleDurationSec: 94,
  lastCycleTrades: 1,
  lastCycleQueued: 2,
  tradeIntervalSec: 1800,
  maxPerCycle: 1,
  autoExitEnabled: false,
  strategy: "medium",
  failedSwapCooldowns: [],
  competitionNudge: false,
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
    fearGreedIndex: 42,
    autonomous: DEMO_AUTONOMOUS,
    maxDrawdownLimit: 20,
    maxDailyTradesLimit: 10,
    maxPositionsLimit: 4,
    emergencyMode: false,
    startedAt: Date.now() - 3 * 3600000,
    startupCooldownMs: 120_000,
    positions: [
      { symbol: "ETH", amount: 0.0421, entryPrice: 3720, currentPrice: 3847, pnl: 5.35, pnlPct: 3.41, weight: 34.2 },
      { symbol: "LINK", amount: 8.5, entryPrice: 14.8, currentPrice: 15.62, pnl: 6.97, pnlPct: 5.54, weight: 28.1 },
      { symbol: "AVAX", amount: 3.2, entryPrice: 33.5, currentPrice: 35.1, pnl: 5.12, pnlPct: 4.78, weight: 23.7 },
      { symbol: "AAVE", amount: 0.85, entryPrice: 97, currentPrice: 93.2, pnl: -3.23, pnlPct: -3.92, weight: 16.8 },
    ],
    trades: [
      { id: "t1", timestamp: Date.now() - 1200000, symbol: "ETH", side: "buy", amount: 0.0421, price: 3720, total: 156.61, txHash: "0x8a3f...d91e" },
      { id: "t2", timestamp: Date.now() - 3600000, symbol: "DOGE", side: "sell", amount: 520, price: 0.158, total: 82.16, txHash: "0x1b7c...4f2a", pnl: 4.12 },
      { id: "t3", timestamp: Date.now() - 7200000, symbol: "LINK", side: "buy", amount: 8.5, price: 14.8, total: 125.8, txHash: "0x9e2d...7b3f" },
      { id: "t4", timestamp: Date.now() - 14400000, symbol: "AVAX", side: "buy", amount: 3.2, price: 33.5, total: 107.2, txHash: "0x4c5a...e8d1" },
      { id: "t5", timestamp: Date.now() - 28800000, symbol: "ADA", side: "sell", amount: 180, price: 0.47, total: 84.6, txHash: "0x6f1b...2c9a", pnl: -2.85 },
      { id: "t6", timestamp: Date.now() - 43200000, symbol: "AAVE", side: "buy", amount: 0.85, price: 97, total: 82.45, txHash: "0x3d8e...f5b7" },
      { id: "t7", timestamp: Date.now() - 57600000, symbol: "DOT", side: "sell", amount: 12, price: 7.45, total: 89.4, txHash: "0xa2c9...1d4e", pnl: 7.2 },
    ],
    signals: [
      { symbol: "ETH", action: "hold", strength: "neutral", score: 12, rsi: 52, macd: 0.08, bbPosition: 52, vwapDev: 0.12, confidence: 0.65, price: 3847, change24h: 1.24, volumeRatio: 0.9 },
      { symbol: "DOGE", action: "buy", strength: "buy", score: 38, rsi: 28, macd: -0.15, bbPosition: 18, vwapDev: -0.42, confidence: 0.72, price: 0.156, change24h: -3.2, volumeRatio: 2.4 },
      { symbol: "LINK", action: "hold", strength: "neutral", score: 8, rsi: 55, macd: 0.05, bbPosition: 48, vwapDev: 0.08, confidence: 0.58, price: 15.62, change24h: 2.1, volumeRatio: 1.1 },
      { symbol: "AVAX", action: "buy", strength: "strong_buy", score: 62, rsi: 24, macd: -0.22, bbPosition: 12, vwapDev: -1.1, confidence: 0.85, price: 35.1, change24h: -5.4, volumeRatio: 3.2 },
      { symbol: "ADA", action: "sell", strength: "sell", score: -34, rsi: 71, macd: 0.31, bbPosition: 88, vwapDev: 1.4, confidence: 0.68, price: 0.47, change24h: 4.8, volumeRatio: 0.4 },
      { symbol: "DOT", action: "hold", strength: "neutral", score: -5, rsi: 48, macd: -0.04, bbPosition: 44, vwapDev: -0.05, confidence: 0.45, price: 7.35, change24h: 0.3, volumeRatio: 0.8 },
      { symbol: "UNI", action: "buy", strength: "buy", score: 29, rsi: 32, macd: -0.11, bbPosition: 22, vwapDev: -0.35, confidence: 0.61, price: 11.2, change24h: -2.8, volumeRatio: 1.8 },
      { symbol: "AAVE", action: "sell", strength: "sell", score: -42, rsi: 73, macd: 0.18, bbPosition: 91, vwapDev: 0.9, confidence: 0.77, price: 93.2, change24h: 5.6, volumeRatio: 1.3 },
    ],
    activity: [
      { id: "a1", timestamp: Date.now() - 60000, type: "brain", message: "Bought ETH (~$156.50)." },
      { id: "a2", timestamp: Date.now() - 180000, type: "brain", message: "Scan complete — 6 signals found. Best pick: AVAX (strong buy, score 62)." },
      { id: "a3", timestamp: Date.now() - 300000, type: "brain", message: "Plan for this cycle: buy AVAX." },
      { id: "a4", timestamp: Date.now() - 420000, type: "brain", message: "Cycle done — watching the market, no trades needed. Status: idle." },
      { id: "a5", timestamp: Date.now() - 600000, type: "trade", message: "Sold DOGE (~$82.16).", detail: "PnL: +$4.12 (+5.28%)" },
      { id: "a6", timestamp: Date.now() - 900000, type: "risk", message: "Passed on ADA — already holding ADA — no duplicate buy." },
      { id: "a7", timestamp: Date.now() - 1200000, type: "signal", message: "Found 3 buy candidates. Top signal: UNI buy (29)." },
      { id: "a8", timestamp: Date.now() - 1800000, type: "error", message: "Trade failed on SHIB: No verified BEP-20 contract." },
    ],
    equityCurve,
    drawdownCurve: generateDrawdownCurve(),
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
    fearGreedIndex: null,
    autonomous: {
      phase: "stopped",
      ready: false,
      headline: "Agent offline",
      blockReason: "Cannot reach agent API",
      tradesToday: 0,
      maxTradesToday: 0,
      tradesLast24h: 0,
      txsToday: 0,
      maxTxsToday: 0,
      swapsRemainingToday: 0,
      emergencyMode: false,
      startupCooldownSec: 0,
      nextCycleInSec: null,
      lastCycleAt: null,
      lastCycleDurationSec: null,
      lastCycleTrades: 0,
      lastCycleQueued: 0,
      tradeIntervalSec: 0,
      maxPerCycle: 0,
      autoExitEnabled: false,
      strategy: "medium",
      failedSwapCooldowns: [],
      competitionNudge: false,
    },
    maxDrawdownLimit: 20,
    maxDailyTradesLimit: 10,
    maxPositionsLimit: 4,
    emergencyMode: false,
    startedAt: null,
    startupCooldownMs: 120_000,
    positions: [],
    trades: [],
    signals: [],
    activity: [],
    equityCurve: [],
    drawdownCurve: [],
  };
}
