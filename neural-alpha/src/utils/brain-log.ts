import { logger } from "./logger.js";
import type { TradeSignal } from "./types.js";

/** Human-readable decision log for the dashboard "Agent Brain" feed. */
export function brain(message: string, data?: Record<string, unknown>, txHash?: string) {
  logger.brain(message, data, txHash);
}

function fmtSignal(s: TradeSignal): string {
  return `${s.symbol} (${s.strength.replace(/_/g, " ")}, ${Math.round(s.score)})`;
}

export function brainCycleStart(cycleId: number, tokenCount: number, fullScan: boolean) {
  brain(
    fullScan
      ? `Cycle ${cycleId} — full scan of ${tokenCount} eligible tokens starting.`
      : `Cycle ${cycleId} — refreshing ${tokenCount} watchlist tokens.`
  );
}

export function brainPortfolioContext(
  holdings: string[],
  cashUsd: number,
  drawdownPct: number,
  slotsUsed: number,
  maxSlots: number
) {
  const hold = holdings.length > 0 ? holdings.join(", ") : "none";
  brain(
    `Portfolio check — ${slotsUsed}/${maxSlots} slots used · $${Math.round(cashUsd)} USDT free · ${drawdownPct.toFixed(1)}% drawdown. Holding: ${hold}.`
  );
}

export function brainSession(clock: {
  label: string;
  nyTimeLabel: string;
  policy: string;
  active: string;
}) {
  brain(
    `Session — ${clock.label} (${clock.nyTimeLabel}). Policy ${clock.policy === "auto" ? "auto" : "locked"} · scoring ${clock.active}.`
  );
}

export function brainCmcMacro(summary: string, sizeScale: number, eventRisk: string) {
  const event = eventRisk === "high" ? " · event-risk ON" : "";
  brain(`CMC overlay — ${summary} · size ${sizeScale.toFixed(2)}x${event}.`);
}

export function brainSignalOverview(
  scanned: number,
  signals: TradeSignal[]
) {
  const buys = signals.filter((s) => s.action === "buy");
  const sells = signals.filter((s) => s.action === "sell");
  const holds = signals.filter((s) => s.action === "hold").length;
  const topBuys = buys.slice(0, 3).map(fmtSignal);
  const topSells = sells.slice(0, 2).map(fmtSignal);

  const parts = [
    `${scanned} tokens scored`,
    `${buys.length} buy`,
    `${sells.length} sell`,
    `${holds} hold`,
  ];
  if (topBuys.length > 0) parts.push(`top buys: ${topBuys.join(", ")}`);
  if (topSells.length > 0) parts.push(`top sells: ${topSells.join(", ")}`);

  brain(`Signal overview — ${parts.join(" · ")}.`);
}

export function brainScanComplete(actionable: number, topBuy?: TradeSignal) {
  if (actionable === 0) {
    brain("Scan complete — no actionable signals, staying patient.");
    return;
  }
  if (topBuy?.action === "buy") {
    brain(
      `Scan complete — ${actionable} actionable signal${actionable === 1 ? "" : "s"}. Best buy: ${fmtSignal(topBuy)}.`
    );
    return;
  }
  brain(`Scan complete — ${actionable} actionable signal${actionable === 1 ? "" : "s"}.`);
}

/** Lighter heartbeat between full trade cycles (signal refresh loop). */
export function brainSignalPulse(
  fullScan: boolean,
  tokenCount: number,
  signals: TradeSignal[]
) {
  const buys = signals.filter((s) => s.action === "buy").slice(0, 3);
  const label = fullScan ? "Full market pulse" : "Market pulse";
  if (buys.length === 0) {
    brain(`${label} — ${tokenCount} tokens updated, no strong buys yet.`);
    return;
  }
  brain(
    `${label} — ${tokenCount} tokens updated. Leading buys: ${buys.map(fmtSignal).join(", ")}.`
  );
}

export function brainQueuedTrades(trades: TradeSignal[]) {
  const buys = trades.filter((t) => t.action === "buy");
  const sells = trades.filter((t) => t.action === "sell");
  if (buys.length === 0 && sells.length === 0) {
    brain("Trade plan — nothing to execute this cycle.");
    return;
  }
  const parts: string[] = [];
  if (sells.length > 0) {
    parts.push(`sell ${sells.map((s) => s.symbol).join(", ")}`);
  }
  if (buys.length > 0) {
    parts.push(`buy ${buys.map((s) => s.symbol).join(", ")}`);
  }
  brain(`Trade plan — ${parts.join(" · ")}.`);
}

export function brainTradeExecuted(
  side: "buy" | "sell",
  symbol: string,
  amountUsd: number,
  txHash?: string
) {
  const verb = side === "buy" ? "Bought" : "Sold";
  brain(`${verb} ${symbol} (~$${amountUsd.toFixed(2)}).`, { side, symbol, amountUsd }, txHash);
}

export function brainTradeSkipped(symbol: string, action: string, reason: string) {
  brain(`Skipped ${action} ${symbol} — ${reason}.`, { symbol, action, reason });
}

export function brainBuyPacing(waitMin: number, candidate?: string) {
  const name = candidate ? ` (${candidate} can wait)` : "";
  brain(`Pacing entries — next buy in ~${waitMin} min. One name at a time${name}.`);
}

export function brainTradeFailed(symbol: string, reason: string) {
  brain(`Trade failed on ${symbol} — ${reason}.`, { symbol, reason });
}

export function brainProtectiveExit(symbols: string[], reasons: string[]) {
  if (symbols.length === 1) {
    brain(`Protective exit on ${symbols[0]}: ${reasons[0] ?? "risk limit hit"}.`);
    return;
  }
  brain(
    `Protective exits on ${symbols.join(", ")} — ${reasons.filter(Boolean).slice(0, 2).join("; ") || "risk limits"}.`
  );
}

export function brainProtectiveWatch(positions: string[]) {
  if (positions.length === 0) return;
  brain(
    `Watching ${positions.length} open position${positions.length === 1 ? "" : "s"} for stop-loss / take-profit — ${positions.join(", ")}.`
  );
}

export function brainEmergency(headline: string) {
  brain(`⚠ ${headline}`);
}

export function brainCycleDone(
  cycleId: number,
  executed: number,
  queued: number,
  phase: string,
  opts?: {
    nextCycleMin?: number | null;
    portfolioUsd?: number;
    tradesToday?: number;
    durationSec?: number;
  }
) {
  const wait =
    opts?.nextCycleMin != null && opts.nextCycleMin > 0
      ? ` Next cycle in ~${Math.max(1, Math.round(opts.nextCycleMin))} min.`
      : "";
  const nav =
    opts?.portfolioUsd != null && opts.portfolioUsd > 0
      ? ` Portfolio ~$${Math.round(opts.portfolioUsd)}.`
      : "";
  const today =
    opts?.tradesToday != null
      ? ` ${opts.tradesToday} trade${opts.tradesToday === 1 ? "" : "s"} today.`
      : "";
  const dur =
    opts?.durationSec != null ? ` (${opts.durationSec}s)` : "";

  if (executed > 0) {
    brain(
      `Cycle ${cycleId} complete${dur} — ${executed}/${queued} planned trade${executed === 1 ? "" : "s"} executed.${today}${nav}${wait} Status: ${phase}.`
    );
    return;
  }
  if (queued > 0) {
    brain(
      `Cycle ${cycleId} complete${dur} — ${queued} trade${queued === 1 ? "" : "s"} considered but none executed.${today}${nav}${wait} Status: ${phase}.`
    );
    return;
  }
  brain(
    `Cycle ${cycleId} complete${dur} — no trades needed.${today}${nav}${wait} Status: ${phase}.`
  );
}

function formatLoopInterval(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return `${min} min`;
}

export function brainAgentStarted(mode: string, tradeIntervalMs: number, signalRefreshMs: number) {
  brain(
    `Agent online (${mode} mode). Trade cycle ~${formatLoopInterval(tradeIntervalMs)} · market pulse ~${formatLoopInterval(signalRefreshMs)}. 24/7 on-chain bStock desk.`
  );
}

export function brainLoopsStarted(protectiveSec: number, autoExit: boolean) {
  if (!autoExit || protectiveSec <= 0) return;
  brain(`Protective exits armed — checking SL and trailing TP every ${protectiveSec}s.`);
}

export function brainRefreshLoopStarted(intervalMs: number) {
  brain(`Signal refresh loop started — live market pulse every ${formatLoopInterval(intervalMs)}.`);
}
