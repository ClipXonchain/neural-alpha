"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Pause, Play } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import type { ActivityItem, Signal, Trade } from "@/lib/mock-data";

const STAGE_MS = 2000;

function BrainMark({ paused }: { paused: boolean }) {
  return (
    <svg className={cn("brain-mark", paused && "opacity-60")} viewBox="0 0 36 36" aria-hidden="true">
      <circle className="brain-orbit" cx="18" cy="18" r="14" />
      <path className="brain-trace" d="M8 21c2.5-7 5-8 7.5-2.5S20 25 23 19s4-8 6-2" />
      <circle className="brain-node" cx="18" cy="18" r="2.1" />
    </svg>
  );
}

function TickerLogo({ symbol, src, size = "sm" }: { symbol: string; src?: string; size?: "sm" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const letter = symbol.replace(/[^A-Z0-9]/gi, "").slice(0, 1) || "?";
  if (src && !failed) {
    return (
      <img
        className={cn("brain-logo", size === "lg" && "lg")}
        src={src}
        alt=""
        width={size === "lg" ? 44 : 26}
        height={size === "lg" ? 44 : 26}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return <span className={cn("brain-logo-fallback", size === "lg" && "lg")}>{letter}</span>;
}

function iconFor(signal: Signal, icons?: ReadonlyMap<string, string>): string | undefined {
  return signal.icon || icons?.get(signal.symbol.toUpperCase());
}

function markPrice(signal: Signal): number {
  return signal.livePrice && signal.livePrice > 0 ? signal.livePrice : signal.price;
}

function money(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "—";
  if (price >= 1000) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(4)}`;
}

function moveLabel(change: number): string {
  if (!Number.isFinite(change)) return "flat";
  const sign = change > 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
}

function stretch(rsi: number): string {
  if (!Number.isFinite(rsi)) return "no read on how stretched it is";
  if (rsi >= 70) return `stretched at ${Math.round(rsi)}`;
  if (rsi <= 35) return `washed out at ${Math.round(rsi)}`;
  return `steady at ${Math.round(rsi)}`;
}

function byScore(a: Signal, b: Signal): number {
  return (b.score ?? 0) - (a.score ?? 0);
}

type Thought = { step: string; title: string; body: string };

function thoughtsFor(
  signal: Signal,
  side: "buy" | "sell",
  owns: boolean,
  blocked: boolean,
  scanned: number,
  buyCount: number,
  sellCount: number,
  armed: boolean
): Thought[] {
  const name = signal.symbol;
  const price = money(markPrice(signal));
  const move = moveLabel(signal.change24h);
  const hold = owns ? "I already hold it" : "I don't hold it";
  return [
    {
      step: "Scan",
      title: "Reading the book",
      body: `${scanned} names on the desk. ${buyCount} on the buy row, ${sellCount} on the sell row.`,
    },
    {
      step: "Review",
      title: `Looking at ${name}`,
      body: `${price}, ${move} today, ${stretch(signal.rsi)}. ${hold}.`,
    },
    {
      step: "Decide",
      title: armed ? (side === "buy" ? "Call is buy" : "Call is sell") : "Still a watch",
      body: armed
        ? `${name} is strong enough. The call is ${side}.`
        : `${name} leads the ${side} row, but it has not cleared the line for an order.`,
    },
    {
      step: "Send",
      title: !armed ? "No order" : blocked ? "Waiting" : "Sending",
      body: !armed
        ? `Nothing to send. I'll keep ${name} on the ${side} row and scan again.`
        : blocked
          ? `The ${side} for ${name} is ready at ${price}. The wallet isn't signed in, so the order waits.`
          : `Sending the ${side} for ${name} at ${price}.`,
    },
  ];
}

type LogKind = "scan" | "buy" | "sell" | "note";

type ExecLog = {
  id: string;
  kind: LogKind;
  message: string;
  timestamp: number;
};

function isNoise(message: string): boolean {
  const text = message.trim();
  if (!text || text.startsWith("{") || text.startsWith("[")) return true;
  if (text.includes("{") && text.includes("}")) return true;
  return /getlogs|gettokenbalance|baw wallet|baw stablecoin|fake-ticker/i.test(text);
}

function kindOf(message: string, type: ActivityItem["type"]): LogKind {
  if (/\bsold\b|\bselling\b/i.test(message) || (type === "trade" && /\bsell\b/i.test(message))) return "sell";
  if (/\bbought\b|\bbuying\b/i.test(message) || (type === "trade" && /\bbuy\b/i.test(message))) return "buy";
  if (type === "brain" || type === "signal" || /\b(scanned|scanning|names on the desk)\b/i.test(message)) return "scan";
  return "note";
}

function tradeLog(trade: Trade): ExecLog {
  const verb = trade.side === "buy" ? "Bought" : "Sold";
  const notional = trade.total > 0 ? ` for $${trade.total.toFixed(2)}` : "";
  const pnl =
    trade.side === "sell" && trade.pnl != null
      ? ` · ${trade.pnl >= 0 ? "+" : "−"}$${Math.abs(trade.pnl).toFixed(2)}`
      : "";
  return {
    id: `trade-${trade.id}`,
    kind: trade.side,
    timestamp: trade.timestamp,
    message: `${verb} ${trade.symbol} at ${money(trade.price)}${notional}${pnl}.`,
  };
}

export function ActivityFeed({
  activity,
  signals,
  held,
  icons,
  trades = [],
}: {
  activity: ActivityItem[];
  signals: Signal[];
  held: string[];
  icons?: ReadonlyMap<string, string>;
  trades?: Trade[];
}) {
  const reduce = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [stage, setStage] = useState(0);
  const [liveLog, setLiveLog] = useState<ExecLog[]>([]);
  const heldSet = useMemo(() => new Set(held.map((symbol) => symbol.toUpperCase())), [held]);

  const open = useMemo(() => signals.filter((signal) => !signal.blacklisted), [signals]);
  const buys = useMemo(
    () => open.filter((signal) => signal.action === "buy" || (signal.action !== "sell" && (signal.score ?? 0) > 0)).sort(byScore),
    [open]
  );
  const sells = useMemo(
    () =>
      open
        .filter((signal) => signal.action === "sell" || (signal.action !== "buy" && (signal.score ?? 0) < 0))
        .sort((a, b) => (a.score ?? 0) - (b.score ?? 0)),
    [open]
  );
  const queue = useMemo(() => [...buys.slice(0, 8), ...sells.slice(0, 4)], [buys, sells]);
  const [cursor, setCursor] = useState(0);
  const lead = queue.length ? queue[cursor % queue.length] : null;
  const side: "buy" | "sell" = lead?.action === "sell" || (lead && (lead.score ?? 0) < 0) ? "sell" : "buy";
  const armed = lead?.action === "buy" || lead?.action === "sell";
  const owns = lead ? heldSet.has(lead.symbol.toUpperCase()) : false;
  const leadKey = lead?.symbol ?? "";
  const blocked = activity.some((item) => /isn.?t signed in|not logged in|can.?t send/i.test(item.message));

  useEffect(() => {
    if (queue.length) return;
    setCursor(0);
    setStage(0);
  }, [queue.length]);

  useEffect(() => {
    if (paused || reduce || !queue.length) return;
    const id = window.setInterval(() => {
      setStage((value) => {
        if (value >= 3) {
          if (queue.length > 1) setCursor((current) => current + 1);
          return 0;
        }
        return value + 1;
      });
    }, STAGE_MS);
    return () => window.clearInterval(id);
  }, [paused, reduce, queue.length]);

  const lines = lead
    ? thoughtsFor(lead, side, owns, blocked, signals.length, buys.length, sells.length, Boolean(armed))
    : [];
  const shown = reduce ? lines : lines.slice(0, stage + 1);
  const logSnap = useRef({ body: "", step: "", kind: "scan" as LogKind, symbol: "" });
  logSnap.current = {
    body: lines[stage]?.body ?? "",
    step: lines[stage]?.step ?? "",
    kind: stage === 0 ? "scan" : armed && stage >= 2 ? side : "note",
    symbol: leadKey,
  };

  useEffect(() => {
    const snap = logSnap.current;
    if (!snap.body || !snap.symbol || paused) return;
    const stamp = Date.now();
    setLiveLog((prev) => {
      const recent = prev[0];
      if (recent && recent.message === snap.body && stamp - recent.timestamp < 2500) return prev;
      return [{ id: `${snap.symbol}-${snap.step}-${stamp}`, kind: snap.kind, message: snap.body, timestamp: stamp }, ...prev].slice(0, 8);
    });
  }, [stage, leadKey, paused]);

  const recent = useMemo(() => {
    const fromActivity: ExecLog[] = activity
      .filter((item) => !isNoise(item.message))
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        kind: kindOf(item.message, item.type),
        message: item.message,
        timestamp: item.timestamp,
      }));
    const merged = [...liveLog, ...trades.slice(0, 6).map(tradeLog), ...fromActivity];
    const seen = new Set<string>();
    const out: ExecLog[] = [];
    for (const row of merged.sort((a, b) => b.timestamp - a.timestamp)) {
      const key = `${row.kind}\0${row.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
      if (out.length >= 8) break;
    }
    return out;
  }, [activity, trades, liveLog]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={cn("agent-brain glass-raised flex min-w-0 flex-col rounded-xl p-3 sm:p-5", paused && "is-paused")}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BrainMark paused={paused} />
          <div>
            <h3 className="text-sm font-semibold tracking-[-0.01em]">Agent Brain</h3>
            <p className="mt-0.5 text-[11px] text-text-muted">
              {paused ? "Paused" : lead ? `Thinking through ${lead.symbol}` : "Waiting for a signal"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          className={cn(
            "flex min-h-9 items-center gap-1.5 rounded border px-2.5 py-1.5 text-[10px] font-semibold",
            paused
              ? "border-warning/20 bg-warning/10 text-warning"
              : "border-border-dim bg-surface-overlay text-text-secondary hover:text-text-primary"
          )}
        >
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
          {paused ? "Resume" : "Pause"}
        </button>
      </div>

      <div className={cn("brain-exec rounded-xl px-4 py-4 sm:px-5", side)} aria-live="polite">
        {lead ? (
          <div className="relative z-[1] flex items-center gap-4">
            <TickerLogo symbol={lead.symbol} src={iconFor(lead, icons)} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[22px] font-semibold tracking-[-0.03em] text-text-primary">{lead.symbol}</p>
                <span className={cn("brain-side", side)}>{side}</span>
                {owns && <span className="brain-side hold">Holding</span>}
              </div>
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] tabular-nums text-text-secondary">
                <span>{money(markPrice(lead))}</span>
                <span className={lead.change24h >= 0 ? "text-neon" : "text-danger"}>{moveLabel(lead.change24h)} today</span>
                <span>{stretch(lead.rsi)}</span>
              </p>
            </div>
          </div>
        ) : (
          <p className="relative z-[1] text-[15px] text-text-secondary">No buy or sell is on the book yet.</p>
        )}

        <div className="brain-thought relative z-[1]">
          {shown.map((line, index) => (
            <motion.div
              key={`${leadKey}-${line.step}`}
              className={cn("brain-line", index === shown.length - 1 && "is-on")}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28 }}
            >
              <i />
              <div>
                <span>{line.step}</span>
                <b>{line.title}</b>
                <p>{line.body}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      <SignalRow
        label="Buy"
        tone="buy"
        rows={buys}
        live={side === "buy" ? lead?.symbol : undefined}
        icons={icons}
      />
      <SignalRow
        label="Sell"
        tone="sell"
        rows={sells}
        live={side === "sell" ? lead?.symbol : undefined}
        icons={icons}
      />

      {recent.length > 0 && (
        <div className="brain-log">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">Recent</p>
          <ul>
            {recent.map((row) => (
              <li key={row.id} className={row.kind}>
                <em>{row.kind}</em>
                <span>{row.message}</span>
                <time>{timeAgo(row.timestamp)}</time>
              </li>
            ))}
          </ul>
        </div>
      )}
    </motion.div>
  );
}

function SignalRow({
  label,
  tone,
  rows,
  live,
  icons,
}: {
  label: string;
  tone: "buy" | "sell";
  rows: Signal[];
  live?: string;
  icons?: ReadonlyMap<string, string>;
}) {
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-baseline justify-between">
        <p className={cn("text-[10px] font-semibold uppercase tracking-[0.16em]", tone === "buy" ? "text-neon" : "text-danger")}>
          {label}
        </p>
        <p className="text-[11px] text-text-muted">{rows.length}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-[13px] text-text-muted">No {label.toLowerCase()} names this pass.</p>
      ) : (
        <div className="brain-row" aria-label={`${label} signals`}>
          {rows.map((signal) => (
            <div
              key={signal.symbol}
              className={cn("brain-pick", tone === "sell" && "is-down", signal.symbol === live && "is-live")}
            >
              <TickerLogo symbol={signal.symbol} src={iconFor(signal, icons)} />
              <span className="min-w-0">
                <b>{signal.symbol}</b>
                <small className={signal.change24h >= 0 ? "up" : "down"}>
                  {money(markPrice(signal))} · {moveLabel(signal.change24h)}
                </small>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
