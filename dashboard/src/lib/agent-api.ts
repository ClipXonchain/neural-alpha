/** Neural Alpha agent HTTP API — proxied via Next.js rewrites at /api/agent/* */

const AGENT_BASE =
  process.env.NEXT_PUBLIC_AGENT_API_URL || "/api/agent";

export interface AutonomousStatus {
  phase: "stopped" | "warming" | "scanning" | "idle" | "blocked";
  ready: boolean;
  headline: string;
  blockReason?: string;
  tradesToday: number;
  maxTradesToday: number;
  tradesLast24h: number;
  txsToday: number;
  maxTxsToday: number;
  swapsRemainingToday: number;
  emergencyMode: boolean;
  startupCooldownSec: number;
  nextCycleInSec: number | null;
  lastCycleAt: number | null;
  lastCycleDurationSec: number | null;
  lastCycleTrades: number;
  lastCycleQueued: number;
  tradeIntervalSec: number;
  maxPerCycle: number;
  autoExitEnabled: boolean;
  strategy: string;
  failedSwapCooldowns: Array<{ symbol: string; remainingMin: number }>;
  competitionNudge: boolean;
}

export interface Track1Snapshot {
  mode: string;
  running: boolean;
  cycleCount: number;
  bridgeSource?: string;
  startedAt?: number;
  fearGreedIndex: number | null;
  watchlist: string[];
  prices: Record<string, number>;
  config: {
    mode?: string;
    strategy?: "safe" | "medium" | "momentum";
    maxDrawdownPct: number;
    maxDailyTrades: number;
    baseCurrency: string;
    swapCurrencies?: string[];
    maxPositionSizeUsd?: number;
    tradeIntervalMs?: number;
    slippageTolerance?: number;
    maxPortfolioTokens?: number;
    startupCooldownMs?: number;
    signalRefreshMs?: number;
    protectiveExitCheckMs?: number;
    stopLossPct?: number;
    takeProfitPct?: number;
    trailingActivatePct?: number;
    minTradablePriceUsd?: number;
    excludedTokens?: string[];
  };
  portfolio: {
    timestamp: number;
    totalValueUsd: number;
    cashUsd: number;
    dailyPnl: number;
    totalPnl: number;
    totalPnlPct: number;
    initialNavUsd?: number;
    realizedPnl?: number;
    gasReserveUsd?: number;
    maxDrawdownPct: number;
    tradeCount: number;
    positions: Array<{
      symbol: string;
      amount: number;
      avgEntryPrice: number;
      currentPrice: number;
      unrealizedPnl: number;
      unrealizedPnlPct: number;
      weight: number;
      stopLossPrice?: number;
      takeProfitPrice?: number;
      distanceToStopPct?: number;
      distanceToTakeProfitPct?: number;
      peakPnlPct?: number;
      entryFromTrades?: boolean;
    }>;
  };
  snapshots: Array<{
    timestamp: number;
    totalValueUsd: number;
    maxDrawdownPct: number;
  }>;
  trades: Array<{
    orderId: string;
    success: boolean;
    txHash?: string;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    toAmount?: string;
    priceAtExecution: number;
    timestamp: number;
    realizedPnl?: number;
  }>;
  risk: Record<string, unknown>;
  tokenMetrics?: Record<
    string,
    {
      momentum: number | null;
      atrPct: number | null;
      score: number | null;
      newsScore?: number | null;
      newsArticles?: number;
      confidence?: number | null;
      rsi?: number | null;
      macd?: number | null;
      bbPosition?: number | null;
      vwapDev?: number | null;
      volumeRatio?: number | null;
      ohlcvReal?: boolean;
      aiSummary?: string;
      aiVerdict?: string;
      aiAgrees?: boolean;
    }
  >;
  newsCount?: number;
  autonomous?: AutonomousStatus;
  startupCooldownRemainingMs?: number;
  lastSignalRefreshAt?: number | null;
  tokenIcons?: Record<string, string>;
  livePrices?: Record<
    string,
    { price: number; change24hPct: number; updatedAt: number }
  >;
  userBlacklisted?: string[];
  binancePositions?: Array<{
    symbol: string;
    name: string;
    remainQty: number;
    price: number;
    percentChange24h: number;
    valueUsd: number;
    contractAddress: string;
    icon?: string;
  }>;
}

export interface WalletSnapshot {
  address: string | null;
  bnbBalance: number;
  usdtBalance: number;
  walletMode: string;
  walletState: string;
  registered: boolean;
  registrationOpen: boolean;
  binancePositions?: Array<{
    symbol: string;
    name: string;
    remainQty: number;
    price: number;
    percentChange24h: number;
    valueUsd: number;
    contractAddress: string;
    icon?: string;
  }>;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  event: string;
  data?: Record<string, unknown>;
  txHash?: string;
}

async function agentFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

const TRADE_TIMEOUT_MS = 180_000;

async function agentFetchLong<T>(path: string, init?: RequestInit): Promise<T> {
  return agentFetch<T>(path, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(TRADE_TIMEOUT_MS),
  });
}

export async function fetchAgentState(): Promise<Track1Snapshot> {
  return agentFetch("/state");
}

export async function fetchWallet(): Promise<WalletSnapshot> {
  return agentFetch("/wallet");
}

export async function fetchLogs(): Promise<LogEntry[]> {
  return agentFetch("/logs");
}

export async function stopAgent(): Promise<void> {
  await agentFetch("/control/stop", { method: "POST" });
}

export async function startAgent(): Promise<void> {
  await agentFetch("/control/start", { method: "POST" });
}

export async function syncWallet(): Promise<{ usdtBalance: number; synced: boolean }> {
  return agentFetch("/wallet/sync", { method: "POST" });
}

export interface ResyncResult {
  ok: boolean;
  portfolioValue: number;
  positions: number;
  cashUsd: number;
}

export async function resyncAgent(): Promise<ResyncResult> {
  return agentFetch("/control/resync", { method: "POST" });
}

export interface CommandResult {
  ok: boolean;
  intent: string;
  message: string;
  data?: Record<string, unknown>;
  suggestions?: string[];
}

export async function sendCommand(command: string): Promise<CommandResult> {
  return agentFetchLong("/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
}

export async function registerCompetition(): Promise<Record<string, unknown>> {
  return agentFetch("/competition/register", { method: "POST" });
}

export async function switchWalletMode(
  mode: "local" | "walletconnect"
): Promise<Record<string, unknown>> {
  return agentFetch("/wallet/mode", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export async function saveAgentConfig(
  updates: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  return agentFetch("/control/config", {
    method: "POST",
    body: JSON.stringify(updates),
  });
}

export async function blacklistToken(symbol: string): Promise<{ ok: boolean; added: boolean; symbols: string[] }> {
  return agentFetch("/blacklist", {
    method: "POST",
    body: JSON.stringify({ action: "add", symbol }),
  });
}

export async function unblacklistToken(symbol: string): Promise<{ ok: boolean; removed: boolean; symbols: string[] }> {
  return agentFetch("/blacklist", {
    method: "POST",
    body: JSON.stringify({ action: "remove", symbol }),
  });
}

const SSE_BASE = process.env.NEXT_PUBLIC_AGENT_SSE_URL || "/api/agent";

export function subscribeAgentEvents(
  onState: (state: Track1Snapshot) => void,
  onLog?: (log: LogEntry) => void
): () => void {
  const es = new EventSource(`${SSE_BASE}/events`);

  es.addEventListener("state", (e) => {
    try {
      onState(JSON.parse(e.data) as Track1Snapshot);
    } catch { /* ignore */ }
  });

  if (onLog) {
    es.addEventListener("log", (ev) => {
      try {
        onLog(JSON.parse(ev.data) as LogEntry);
      } catch { /* ignore */ }
    });
  }

  es.onerror = () => { /* browser auto-reconnects */ };

  return () => es.close();
}

export async function checkAgentConnection(): Promise<boolean> {
  try {
    await fetchAgentState();
    return true;
  } catch {
    return false;
  }
}

export { AGENT_BASE };
