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
  stochRsi: number | null;
  vwap: number | null;
  gapPct: number | null;
  orb: { high: number; low: number; breakoutPct: number } | null;
  atrPct: number | null;
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
  session?: "rth" | "close" | "overnight";
  gapPct?: number | null;
  stochRsi?: number | null;
  atrPct?: number | null;
  vwapDev?: number | null;
  orbBreakoutPct?: number | null;
  regime?: "risk_on" | "risk_off" | "neutral";
  /** LLM technical analysis overlay (optional). */
  ai?: {
    summary: string;
    verdict: "bullish" | "bearish" | "neutral" | "caution";
    agreesWithSignal: boolean;
    risks: string[];
    confidence: number;
  };
}

export interface TradeOrder {
  id: string;
  timestamp: number;
  symbol: string;
  side: "buy" | "sell";
  amountUsd: number;
  /** For sells: full token quantity to swap (baw expects human-readable token units). */
  fromTokenAmount?: number;
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
  /** Realized PnL (USD) booked when this trade closes/reduces a position. */
  realizedPnl?: number;
}

export interface PortfolioPosition {
  symbol: string;
  amount: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  weight: number;
  /** Fixed exit levels derived from entry + strategy config. */
  stopLossPrice?: number;
  takeProfitPrice?: number;
  /** Percentage points until stop-loss fires (≤0 = at or past SL). */
  distanceToStopPct?: number;
  /** Percentage points until take-profit fires (≤0 = at or past TP). */
  distanceToTakeProfitPct?: number;
  /** Best unrealized PnL % seen this hold (trailing-stop reference). */
  peakPnlPct?: number;
  /** Whether avg entry was reconstructed from confirmed buy trades. */
  entryFromTrades?: boolean;
}

export interface PortfolioSnapshot {
  timestamp: number;
  totalValueUsd: number;
  cashUsd: number;
  positions: PortfolioPosition[];
  dailyPnl: number;
  totalPnl: number;
  totalPnlPct: number;
  realizedPnl: number;
  /** NAV baseline for lifetime PnL (set when wallet sync anchors capital). */
  initialNavUsd?: number;
  /** Yesterday's close / UTC midnight NAV — Daily PnL = current − this. */
  dayStartNavUsd?: number;
  gasReserveUsd?: number;
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
  /** Session policy: follow NY clock, or lock RTH / Close / Overnight. */
  sessionPolicy: "auto" | "rth" | "close" | "overnight";
  /** Multiplier on computed position size (from the active session profile). */
  positionSizeMultiplier: number;
  tradeIntervalMs: number;
  maxPositionSizeUsd: number;
  maxDrawdownPct: number;
  /** When false, drawdown gates and emergency mode are disabled. */
  drawdownLimitEnabled: boolean;
  /** How often to re-scan markets and recompute signals (independent of trade cycle). */
  signalRefreshMs: number;
  /** How often to check stop-loss / take-profit / trailing (independent of trade cycle). */
  protectiveExitCheckMs: number;
  slippageTolerance: number;
  /** BNB (USD) kept for gas — never used to buy bStock. */
  minGasReserveUsd: number;
  baseCurrency: string;
  /** Currencies used to fund buys (USDT first, then BNB). Sells settle to baseCurrency. */
  swapCurrencies: string[];
  maxPortfolioTokens: number;
  minTradeAmountUsd: number;
  rebalanceThresholdPct: number;
  /** Hard stop-loss: exit a position once it falls this % below entry. */
  stopLossPct: number;
  /** Take-profit: lock gains once a position rises this % above entry. */
  takeProfitPct: number;
  /** Trailing stop activates once unrealized gain exceeds this %. */
  trailingActivatePct: number;
  /** Once active, exit if price gives back this many % points from peak gain. */
  trailingGivebackPct: number;
  /** Min confidence (0-1) required to open a new position. */
  minBuyConfidence: number;
  /** When false, skip stop-loss / take-profit / trailing auto-sells each cycle. */
  autoExitEnabled: boolean;
  /** After a failed autonomous swap, block retries for this symbol (ms). */
  failedSwapCooldownMs: number;
  /** Minimum wait after a successful buy before opening another name. */
  minBuyIntervalMs: number;
  /** Dashboard / API: tokens blocklisted from scans and new buys. */
  excludedTokens?: string[];
  /** Dashboard / API: minimum USD price to consider tradable. */
  minTradablePriceUsd?: number;
}

export interface PortfolioHolding {
  symbol: string;
  amount: number;
  priceUsd?: number;
  valueUsd?: number;
}

export type ExitKind = "stop_loss" | "take_profit" | "trailing_stop";

export interface RiskExit {
  symbol: string;
  kind: ExitKind;
  reason: string;
  pnlPct: number;
}

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "trade" | "signal" | "risk" | "brain";
  event: string;
  /** Human-readable line for dashboard brain feed (falls back to event). */
  narrative?: string;
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
