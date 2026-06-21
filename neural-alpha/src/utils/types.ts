export interface TokenInfo {
  symbol: string;
  name?: string;
  address?: string;
  decimals?: number;
}

export interface PricePoint {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface MarketData {
  symbol: string;
  price: number;
  change24h?: number;
  volume24h?: number;
  marketCap?: number;
  fearGreedIndex?: number;
  socialScore?: number;
  timestamp: number;
}

export interface TechnicalSignals {
  rsi: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  ema: { fast: number; slow: number } | null;
  bollingerBands: { upper: number; middle: number; lower: number } | null;
  atr: number | null;
  volumeRatio: number | null;
}

export type SignalStrength = "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";

export interface TradeSignal {
  symbol: string;
  action: "buy" | "sell" | "hold";
  strength: SignalStrength;
  score: number;
  reasons: string[];
  targetAllocationPct: number;
  confidence: number;
}

export interface TradeOrder {
  id: string;
  timestamp: number;
  symbol: string;
  side: "buy" | "sell";
  amountUsd: number;
  fromToken: string;
  toToken: string;
  slippage: number;
}

export interface TradeResult {
  orderId: string;
  success: boolean;
  txHash?: string;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount?: string;
  priceAtExecution: number;
  timestamp: number;
  error?: string;
}

export interface PortfolioPosition {
  symbol: string;
  amount: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  weight: number;
}

export interface PortfolioSnapshot {
  timestamp: number;
  totalValueUsd: number;
  cashUsd: number;
  positions: PortfolioPosition[];
  dailyPnl: number;
  totalPnl: number;
  totalPnlPct: number;
  maxDrawdownPct: number;
  tradeCount: number;
}

export interface RiskCheck {
  passed: boolean;
  violations: string[];
  drawdownPct: number;
  dailyTradeCount: number;
  positionSizePct: number;
}

export interface AgentConfig {
  mode: "live" | "paper";
  tradeIntervalMs: number;
  maxPositionSizeUsd: number;
  maxDailyTrades: number;
  maxDrawdownPct: number;
  slippageTolerance: number;
  baseCurrency: string;
  maxPortfolioTokens: number;
  minTradeAmountUsd: number;
  rebalanceThresholdPct: number;
}

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "trade" | "signal" | "risk";
  event: string;
  data?: Record<string, unknown>;
  txHash?: string;
}

export interface CycleResult {
  cycleId: number;
  timestamp: number;
  marketsAnalyzed: number;
  signalsGenerated: TradeSignal[];
  tradesExecuted: TradeResult[];
  portfolioSnapshot: PortfolioSnapshot;
  duration: number;
}
