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

  if (event === "Strategy analysis complete" || event === "Market signals refreshed") {
    return null;
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

/** Turn telemetry into a sentence a person can follow. Null means "don't show this". */
function speak(raw: string): { message: string; type?: ActivityItem["type"] } | null {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s || s.startsWith("{") || s.startsWith("[")) return null;
  if (/filtered wallet spam|fake-ticker|binance web3 enrichment/i.test(s)) return null;

  if (/getlogs scan failed|falling back to tx\.from/i.test(s)) {
    return {
      message: "Chain history is slow, so I'm reading transfers from the wallet instead.",
      type: "info",
    };
  }
  if (/baw (wallet|stablecoin)|not logged in/i.test(s)) {
    return {
      message: "Trading wallet isn't signed in. I can see the book, but I can't send a swap yet.",
      type: "risk",
    };
  }
  if (/gettokenbalance failed|baw .*(failed|error)/i.test(s)) {
    return {
      message: "I couldn't read one balance from the trading wallet. I'll try again on the next pass.",
      type: "risk",
    };
  }
  if (/cycle finished/i.test(s)) {
    return { message: "This cycle didn't need a trade. I'm still scanning.", type: "info" };
  }

  const quiet = s.match(/^(?:Full market pulse|Market pulse) — (\d+) tokens updated, no strong buys yet\.$/);
  if (quiet) {
    return {
      message: `${s.startsWith("Full") ? "Full look" : "Quick look"} at ${quiet[1]} names. Nothing strong enough to buy.`,
      type: "brain",
    };
  }

  const pulse = s.match(/^(?:Full market pulse|Market pulse) — (\d+) tokens updated\. Leading buys: (.+)\.$/);
  if (pulse) {
    return {
      message: `${s.startsWith("Full") ? "Full look" : "Quick look"} at ${pulse[1]} names. Strongest buys: ${nameList(pulse[2])}.`,
      type: "brain",
    };
  }

  if (/^Scanned the market — no buy/i.test(s)) {
    return { message: "Nothing is strong enough to buy. Staying patient.", type: "brain" };
  }

  return { message: s };
}

function nameList(blob: string): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of blob.matchAll(/([A-Z0-9]{2,12})\s*\((?:buy|sell|hold),\s*(\d+)\)/gi)) {
    const symbol = match[1].toUpperCase();
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    names.push(`${symbol} ${match[2]}`);
  }
  if (names.length === 0) return blob.replace(/\.$/, "");
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function mapLevel(log: LogEntry, narrative: string): ActivityItem["type"] {
  if (log.level === "brain") return "brain";
  if (log.level === "trade") return "trade";
  if (log.level === "signal") return "signal";
  if (log.level === "risk") return "risk";
  if (log.level === "error") return "error";
  if (/bought|sold|traded|swap confirmed/i.test(narrative)) return "trade";
  if (/exit|drawdown|emergency|blocked|blacklist|protective|passed on|skipped|isn't signed in|can't send/i.test(narrative)) {
    return "risk";
  }
  if (/^(full look|quick look|watching|scan complete)/i.test(narrative)) return "signal";
  return "info";
}

const HEARTBEAT: ReadonlySet<ActivityItem["type"]> = new Set(["brain", "signal", "info", "risk"]);

/** One copy of a repeating status line, kept at the latest time it was said. */
export function collapseActivity(items: ActivityItem[]): ActivityItem[] {
  const last = new Map<string, number>();
  items.forEach((item, index) => {
    if (!HEARTBEAT.has(item.type)) return;
    last.set(`${item.type}\0${item.message}`, index);
  });
  const out: ActivityItem[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const key = `${item.type}\0${item.message}`;
    if (HEARTBEAT.has(item.type) && last.get(key) !== index) continue;
    const prev = out[out.length - 1];
    if (prev && prev.type === item.type && prev.message === item.message) continue;
    out.push({ ...item });
  }
  return out;
}

export function mergeActivity(prev: ActivityItem[], next: ActivityItem): ActivityItem[] {
  const existing = HEARTBEAT.has(next.type)
    ? prev.find((item) => item.type === next.type && item.message === next.message)
    : undefined;
  const rest = existing ? prev.filter((item) => item !== existing) : prev;
  const item = existing ? { ...next, id: existing.id } : next;
  return [item, ...rest].slice(0, 120);
}

export function logEntryToActivity(log: LogEntry, id: string): ActivityItem | null {
  if (matchesHidden(log.event) && log.level !== "brain" && log.level !== "error") {
    return null;
  }

  const raw =
    log.narrative ??
    formatLegacyNarrative(log) ??
    (log.level === "brain" || log.level === "warn" || log.level === "error" ? log.event : null);

  if (!raw) return null;
  const spoken = speak(raw);
  if (!spoken) return null;
  const narrative = spoken.message;

  if (log.level === "error" && spoken.type == null && narrative === log.event) {
    return {
      id,
      timestamp: new Date(log.timestamp).getTime(),
      type: "error",
      message: narrative,
    };
  }

  const type = spoken.type ?? mapLevel(log, narrative);

  return {
    id,
    timestamp: new Date(log.timestamp).getTime(),
    type,
    message: narrative,
  };
}

export function mapActivityLogs(logs: LogEntry[]): ActivityItem[] {
  const items = collapseActivity(
    logs
      .map((log, i) => logEntryToActivity(log, `${log.timestamp}-${i}`))
      .filter((item): item is ActivityItem => item != null)
  );
  return items.slice(-80).reverse();
}
