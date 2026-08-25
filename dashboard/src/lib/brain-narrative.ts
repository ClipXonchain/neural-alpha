import type { LogEntry } from "./agent-api";
import type { ActivityItem } from "./mock-data";

/** Technical events hidden from the default brain feed (still in server logs). */
const HIDDEN_EVENTS = new Set([
  "Risk status",
  "Market data fetched",
  "Binance Web3 enrichment applied",
  "Agentic Wallet swap raw response",
  "Signal refresh loop started",
  "Protective exit loop started",
  "Wallet capital synced from chain",
  "On-chain wallet synced",
  "Cycle complete",
  "Signal generated",
  "Trade persisted to DB",
  "Primed token for manual trade",
  "Position imported for manual trade",
  "Manual portfolio resync requested",
]);

function matchesHidden(event: string): boolean {
  if (HIDDEN_EVENTS.has(event)) return true;
  return (
    event.startsWith("=== Cycle") ||
    event.startsWith("CLI wallet scan") ||
    event.startsWith("Token balance recovered") ||
    event.startsWith("Position preserved after")
  );
}

function formatLegacyNarrative(log: LogEntry): string | null {
  const d = log.data ?? {};
  const event = log.event;

  if (log.narrative) return log.narrative;

  if (event === "Strategy analysis complete") {
    const buys = Number(d.buys ?? 0);
    const top = d.topSignal ? String(d.topSignal) : null;
    if (buys === 0) return "Scanned the market — no buy signals strong enough right now.";
    return top
      ? `Found ${buys} buy candidate${buys === 1 ? "" : "s"}. Top signal: ${top}.`
      : `Found ${buys} buy candidate${buys === 1 ? "" : "s"}.`;
  }

  if (event === "Market signals refreshed") {
    const tokens = Number(d.tokens ?? 0);
    const scored = Number(d.scored ?? 0);
    const fullScan = !!d.fullScan;
    return fullScan
      ? `Full market refresh — ${tokens} tokens updated, ${scored} scored.`
      : `Market refresh — ${tokens} tokens updated, ${scored} scored.`;
  }

  if (event === "Autonomous cycle summary") {
    const executed = Number(d.tradesExecuted ?? 0);
    const queued = Number(d.queued ?? 0);
    const phase = String(d.phase ?? "idle");
    if (executed > 0) {
      return `Cycle finished — ${executed} trade${executed === 1 ? "" : "s"} executed. Status: ${phase}.`;
    }
    return `Cycle finished — no trades needed. Status: ${phase}${queued > 0 ? ` (${queued} were considered)` : ""}.`;
  }

  if (event === "Trade not approved" || event === "Autonomous trade blocked") {
    const sym = String(d.symbol ?? "?");
    const reasons = Array.isArray(d.reasons)
      ? d.reasons
      : d.reason
        ? [String(d.reason)]
        : ["did not pass checks"];
    return `Passed on ${sym} — ${reasons[0]}.`;
  }

  if (event === "Protective exit triggered in trade cycle" || event === "Protective exit check firing sells") {
    const exits = Array.isArray(d.exits)
      ? d.exits
      : Array.isArray(d.symbols)
        ? d.symbols
        : [];
    if (exits.length === 0) return "Protective exit triggered.";
    return `Protective exit on ${exits.join(", ")}.`;
  }

  if (event.startsWith("EMERGENCY MODE")) {
    return "Drawdown is elevated — pausing new buys, holding current positions.";
  }

  if (event === "PAPER trade executed" || event.startsWith("Trade persisted to DB")) {
    const side = String(d.side ?? "trade");
    const sym = String(d.symbol ?? "?");
    const usd = Number(d.amountUsd ?? 0);
    const verb = side === "buy" ? "Bought" : side === "sell" ? "Sold" : "Traded";
    return usd > 0 ? `${verb} ${sym} (~$${usd.toFixed(2)}).` : `${verb} ${sym}.`;
  }

  if (event === "Trade execution error") {
    return `Trade failed on ${String(d.symbol ?? "?")}: ${String(d.error ?? "unknown error")}.`;
  }

  if (event === "Live swap not confirmed on-chain — portfolio unchanged") {
    return `Swap for ${String(d.symbol ?? "?")} did not confirm on-chain — no position change.`;
  }

  if (event === "Startup cooldown — autonomous trades paused") {
    const sec = Number(d.remainingSec ?? 0);
    const q = Number(d.queued ?? 0);
    return q > 0
      ? `Warming up (${sec}s) — ${q} trade${q === 1 ? "" : "s"} waiting.`
      : `Warming up — ${sec}s until trading starts.`;
  }

  if (event === "Agent started — entering trading loop") {
    return "Agent is online and watching the market.";
  }

  if (log.level === "error") {
    return event;
  }

  if (log.level === "warn" && !matchesHidden(event)) {
    return event;
  }

  return null;
}

function mapLevel(log: LogEntry, narrative: string): ActivityItem["type"] {
  if (log.level === "brain") return "brain";
  if (log.level === "trade") return "trade";
  if (log.level === "signal") return "signal";
  if (log.level === "risk") return "risk";
  if (log.level === "error") return "error";
  if (/bought|sold|trade|swap/i.test(narrative)) return "trade";
  if (/exit|drawdown|emergency|blocked|blacklist|protective|passed on|skipped/i.test(narrative)) {
    return "risk";
  }
  if (/signal|scan|pick|opportunit|trade plan|market pulse|signal overview|market refresh|market mood|portfolio check|watching/i.test(narrative)) {
    return "signal";
  }
  return "info";
}

export function logEntryToActivity(log: LogEntry, id: string): ActivityItem | null {
  if (matchesHidden(log.event) && log.level !== "brain" && log.level !== "error") {
    return null;
  }

  const narrative =
    log.narrative ??
    formatLegacyNarrative(log) ??
    (log.level === "brain" ? log.event : null);

  if (!narrative) {
    if (log.level === "error") {
      return {
        id,
        timestamp: new Date(log.timestamp).getTime(),
        type: "error",
        message: log.event,
        detail: log.data ? JSON.stringify(log.data) : log.txHash,
      };
    }
    return null;
  }

  const type = mapLevel(log, narrative);
  const showDetail =
    log.txHash ||
    (log.data &&
      type !== "brain" &&
      type !== "signal" &&
      Object.keys(log.data).length > 0);

  return {
    id,
    timestamp: new Date(log.timestamp).getTime(),
    type,
    message: narrative,
    detail: showDetail
      ? log.txHash
        ? `tx: ${log.txHash}${log.data ? `\n${JSON.stringify(log.data, null, 2)}` : ""}`
        : log.data
          ? JSON.stringify(log.data)
          : undefined
      : undefined,
  };
}

export function mapActivityLogs(logs: LogEntry[]): ActivityItem[] {
  return logs
    .map((log, i) => logEntryToActivity(log, `${log.timestamp}-${i}`))
    .filter((item): item is ActivityItem => item != null)
    .slice(-120)
    .reverse();
}
