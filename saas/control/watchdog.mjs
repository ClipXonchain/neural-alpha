/**
 * Decides which agents need attention. Pure: the scheduler reads each desk,
 * passes the last saved state in, and stores the state that comes back.
 *
 * An issue opens after it holds for two checks in a row and resolves the first
 * check it clears, so one slow answer never pages anyone.
 */
export const MISS_LIMIT = 2;
const ISSUES = {
  agent_down: {
    open: "is not responding",
    customer: "Your Neural Alpha agent is not responding. We are looking into it. Stop-losses and exits only run while the agent is up.",
  },
  agent_stopped: {
    open: "loop is stopped",
    customer: "Your Neural Alpha agent has stopped trading. Open the portal to start it again, or contact support if you did not stop it.",
  },
  agent_stalled: {
    open: "has not finished a cycle for too long",
    customer: "Your Neural Alpha agent is running but has not finished a trading cycle for a while. We are looking into it.",
  },
};

export function parseAlerts(json) {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const fmtUsd = (n) => `$${Math.abs(Number(n) || 0).toFixed(2)}`;

function tradeText(trade, mode) {
  const tag = mode === "live" ? "" : "[paper] ";
  if (trade.side === "buy") return `${tag}Bought ${trade.symbol || "a token"} for ${fmtUsd(trade.usd)}`;
  const pnl = trade.pnl == null ? "" : ` (${trade.pnl >= 0 ? "+" : "-"}${fmtUsd(trade.pnl)})`;
  return `${tag}Sold ${trade.symbol || "a token"} for ${fmtUsd(trade.usd)}${pnl}`;
}

/**
 * @param {{ row: object, desk: object, nowMs: number, prev?: object, stallMs: number }} input
 * @returns {{ next: object, events: Array<{ type: "open" | "resolved" | "trade", kind?: string, customer: string, ops?: string }> }}
 */
export function evaluate({ row, desk, nowMs, prev = {}, stallMs }) {
  // A paused or stopped agent is intentional, so nothing is wrong.
  if (row.status !== "running") return { next: { ...prev, miss: {}, cycle: undefined, open: {} }, events: [] };
  const events = [];
  const open = { ...(prev.open || {}) };
  const miss = { ...(prev.miss || {}) };
  const tag = `Agent ${row.id}`;

  const active = {
    agent_down: !desk.reachable,
    agent_stopped: Boolean(desk.reachable && desk.running === false),
    agent_stalled: false,
  };
  let cycle = prev.cycle;
  if (desk.reachable && desk.running !== false) {
    const n = Number(desk.cycleCount) || 0;
    if (!cycle || n !== cycle.n) cycle = { n, at: nowMs };
    active.agent_stalled = nowMs - cycle.at > stallMs;
  }

  for (const [kind, on] of Object.entries(active)) {
    miss[kind] = on ? (miss[kind] || 0) + 1 : 0;
    if (on && miss[kind] >= MISS_LIMIT && !open[kind]) {
      open[kind] = { since: nowMs };
      events.push({ type: "open", kind, customer: ISSUES[kind].customer, ops: `${tag} ${ISSUES[kind].open}` });
    } else if (!on && open[kind]) {
      delete open[kind];
      events.push({ type: "resolved", kind, customer: "Your Neural Alpha agent is back to normal.", ops: `${tag} recovered (${kind})` });
    }
  }

  // Trades are told apart by transaction hash (time if there is none), so a clock that
  // moves or a reordered list never repeats one. The first look only records what is
  // already there, so a new link never replays history.
  let seen = Array.isArray(prev.seen) ? prev.seen : undefined;
  const recent = Array.isArray(desk.recent) ? desk.recent : [];
  const keyOf = (t) => t.tx || `t${t.time}`;
  if (desk.reachable) {
    if (seen === undefined) {
      seen = recent.map(keyOf);
    } else {
      const known = new Set(seen);
      const fresh = recent
        .filter((t) => !known.has(keyOf(t)))
        .sort((a, b) => a.time - b.time)
        .slice(-5);
      for (const t of fresh) events.push({ type: "trade", customer: tradeText(t, row.agent_mode) });
      seen = [...seen, ...recent.map(keyOf).filter((k) => !known.has(k))].slice(-100);
    }
  }

  return { next: { miss, open, cycle, seen }, events };
}
