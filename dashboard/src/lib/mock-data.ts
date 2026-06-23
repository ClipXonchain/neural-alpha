export interface Position {
  symbol: string;
  amount: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPct: number;
  weight: number;
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
  macd: number;
  confidence: number;
  price: number;
  change24h: number;
  newsScore?: number | null;
  newsArticles?: number;
  volumeRatio?: number | null;
  aiSummary?: string;
  aiVerdict?: "bullish" | "bearish" | "neutral" | "caution";
  aiAgrees?: boolean;
}

export interface ActivityItem {
  id: string;
  timestamp: number;
  type: "trade" | "signal" | "risk" | "info" | "error";
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
  totalPnl: number;
  totalPnlPct: number;
  realizedPnl: number;
  gasReserveUsd: number;
  dailyPnl: number;
  dailyPnlPct: number;
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  todayTrades: number;
  totalTrades: number;
  winRate: number;
  fearGreedIndex: number;
  positions: Position[];
  trades: Trade[];
  signals: Signal[];
  activity: ActivityItem[];
  equityCurve: Array<{ time: string; value: number; pnl: number }>;
  drawdownCurve: Array<{ time: string; drawdown: number }>;
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
    totalPnl: latestValue - 1000,
    totalPnlPct: ((latestValue - 1000) / 1000) * 100,
    realizedPnl: 18.62,
    gasReserveUsd: 0,
    dailyPnl: 23.47,
    dailyPnlPct: 2.18,
    maxDrawdownPct: 8.4,
    currentDrawdownPct: 2.1,
    todayTrades: 4,
    totalTrades: 67,
    winRate: 61.2,
    fearGreedIndex: 42,
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
      { symbol: "ETH", action: "hold", strength: "neutral", score: 12, rsi: 52, macd: 0.3, confidence: 0.65, price: 3847, change24h: 1.24, volumeRatio: 0.9 },
      { symbol: "DOGE", action: "buy", strength: "buy", score: 38, rsi: 28, macd: -0.8, confidence: 0.72, price: 0.156, change24h: -3.2, volumeRatio: 2.4 },
      { symbol: "LINK", action: "hold", strength: "neutral", score: 8, rsi: 55, macd: 0.1, confidence: 0.58, price: 15.62, change24h: 2.1, volumeRatio: 1.1 },
      { symbol: "AVAX", action: "buy", strength: "strong_buy", score: 62, rsi: 24, macd: -1.2, confidence: 0.85, price: 35.1, change24h: -5.4, volumeRatio: 3.2 },
      { symbol: "ADA", action: "sell", strength: "sell", score: -34, rsi: 71, macd: 1.5, confidence: 0.68, price: 0.47, change24h: 4.8, volumeRatio: 0.4 },
      { symbol: "DOT", action: "hold", strength: "neutral", score: -5, rsi: 48, macd: -0.2, confidence: 0.45, price: 7.35, change24h: 0.3, volumeRatio: 0.8 },
      { symbol: "UNI", action: "buy", strength: "buy", score: 29, rsi: 32, macd: -0.6, confidence: 0.61, price: 11.2, change24h: -2.8, volumeRatio: 1.8 },
      { symbol: "AAVE", action: "sell", strength: "sell", score: -42, rsi: 73, macd: 2.1, confidence: 0.77, price: 93.2, change24h: 5.6, volumeRatio: 1.3 },
    ],
    activity: [
      { id: "a1", timestamp: Date.now() - 60000, type: "trade", message: "BUY 0.0421 ETH @ $3,720", detail: "Score: 45 | Confidence: 82%" },
      { id: "a2", timestamp: Date.now() - 180000, type: "signal", message: "Strong buy signal: AVAX", detail: "RSI: 24 (oversold) + MACD bullish cross" },
      { id: "a3", timestamp: Date.now() - 300000, type: "risk", message: "Position limit check passed", detail: "4/5 positions used" },
      { id: "a4", timestamp: Date.now() - 420000, type: "info", message: "Cycle #847 complete", detail: "8 markets analyzed, 2 signals" },
      { id: "a5", timestamp: Date.now() - 600000, type: "trade", message: "SELL 520 DOGE @ $0.158", detail: "PnL: +$4.12 (+5.28%)" },
      { id: "a6", timestamp: Date.now() - 900000, type: "info", message: "Fear & Greed Index: 42 (Fear)", detail: "Contrarian overlay active" },
      { id: "a7", timestamp: Date.now() - 1200000, type: "signal", message: "Sell signal: ADA", detail: "RSI: 71 (overbought) + momentum negative" },
      { id: "a8", timestamp: Date.now() - 1800000, type: "error", message: "Price fetch failed: SHIB", detail: "Retrying in 30s..." },
    ],
    equityCurve,
    drawdownCurve: generateDrawdownCurve(),
  };
}
