"use client";

import { useEffect, useMemo, useState, Fragment } from "react";
import { Ban, ChevronDown, Radar, Search, Undo2, X } from "lucide-react";
import { cn, formatTokenPrice, formatPct } from "@/lib/utils";
import type { Signal } from "@/lib/mock-data";
import {
  clockSession,
  sessionPlaybook,
  stockEdge,
  type SessionName,
} from "@/lib/session";

const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "DAI", "USD1", "USDE", "USDD", "TUSD", "FDUSD", "USDF",
  "FRAX", "FRXUSD", "DUSD", "LISUSD", "EURI", "XUSD", "STABLE", "BUSD", "BNB", "U",
]);

type Tab = "all" | "buy" | "sell" | "hold" | "blocked";
type SortKey =
  | "score"
  | "symbol"
  | "price"
  | "change24h"
  | "rsi"
  | "stochRsi"
  | "macd"
  | "bbPosition"
  | "vwapDev"
  | "gapPct"
  | "orbBreakoutPct"
  | "atrPct"
  | "volumeRatio"
  | "newsScore"
  | "confidence";

function asSession(raw?: string): SessionName {
  if (raw === "rth" || raw === "close" || raw === "overnight") return raw;
  return clockSession();
}

function fmt(value: number | null | undefined, digits = 1, suffix = ""): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}${suffix}`;
}

function signed(value: number | null | undefined, digits = 2, suffix = ""): string {
  if (value == null || Number.isNaN(value)) return "—";
  const n = value.toFixed(digits);
  return `${value > 0 ? "+" : ""}${n}${suffix}`;
}

function toneClass(tone: string): string {
  if (tone === "neon") return "text-neon";
  if (tone === "cyan") return "text-cyan";
  if (tone === "danger") return "text-danger";
  if (tone === "warning") return "text-warning";
  return "text-text-muted";
}

function ActionBadge({ strength }: { strength: Signal["strength"] }) {
  const config = {
    strong_buy: { label: "STR BUY", color: "text-neon bg-neon/10 border-neon/20" },
    buy: { label: "BUY", color: "text-neon/80 bg-neon/5 border-neon/10" },
    neutral: { label: "HOLD", color: "text-text-secondary bg-surface-overlay border-border-dim" },
    sell: { label: "SELL", color: "text-danger/80 bg-danger/5 border-danger/10" },
    strong_sell: { label: "STR SELL", color: "text-danger bg-danger/10 border-danger/20" },
  }[strength];
  return (
    <span
      className={cn(
        "inline-flex text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border whitespace-nowrap",
        config.color
      )}
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {config.label}
    </span>
  );
}

function TokenLogo({ symbol, icon }: { symbol: string; icon?: string }) {
  const [failed, setFailed] = useState(false);
  if (icon && !failed) {
    return (
      <img
        src={icon}
        alt=""
        referrerPolicy="no-referrer"
        className="size-6 rounded-full shrink-0 bg-surface-overlay object-cover ring-1 ring-border-dim/60"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="flex items-center justify-center size-6 rounded-full shrink-0 bg-surface-overlay text-[9px] font-bold text-text-muted ring-1 ring-border-dim/60"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {symbol.slice(0, 2)}
    </span>
  );
}

function Th({
  label,
  sortKey,
  current,
  dir,
  onSort,
  align = "right",
  title,
}: {
  label: string;
  sortKey?: SortKey;
  current?: SortKey;
  dir?: "asc" | "desc";
  onSort?: (key: SortKey) => void;
  align?: "left" | "right";
  title?: string;
}) {
  const active = sortKey && current === sortKey;
  return (
    <th
      title={title}
      className={cn(
        "px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted whitespace-nowrap",
        align === "left" ? "text-left" : "text-right",
        sortKey && "cursor-pointer select-none hover:text-text-secondary"
      )}
      onClick={sortKey && onSort ? () => onSort(sortKey) : undefined}
    >
      {label}
      {active && (dir === "asc" ? " ↑" : " ↓")}
    </th>
  );
}

function Td({
  children,
  hot,
  cold,
  align = "right",
  className,
}: {
  children: React.ReactNode;
  hot?: boolean;
  cold?: boolean;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-2 py-2.5 tabular-nums text-[12px] whitespace-nowrap",
        align === "left" ? "text-left" : "text-right",
        hot && "text-neon",
        cold && "text-danger",
        !hot && !cold && "text-text-primary",
        className
      )}
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {children}
    </td>
  );
}

export function SignalMonitor({
  signals,
  lastSignalRefreshAt,
  signalRefreshSec,
  session: sessionProp,
  readOnly,
  onBlacklist,
  onUnblacklist,
}: {
  signals: Signal[];
  lastSignalRefreshAt?: number | null;
  signalRefreshSec: number;
  session?: string;
  readOnly?: boolean;
  onBlacklist?: (symbol: string) => Promise<void>;
  onUnblacklist?: (symbol: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [busySymbol, setBusySymbol] = useState<string | null>(null);
  const [openAi, setOpenAi] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const session = asSession(sessionProp);
  const playbook = sessionPlaybook(session);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setSortDir(key === "symbol" ? "asc" : "desc");
    }
  };

  const blocked = signals.filter((s) => s.blacklisted);
  const book = signals.filter(
    (s) => !STABLE_SYMBOLS.has(s.symbol.toUpperCase()) && !s.blacklisted
  );

  const filtered = useMemo(() => {
    let rows = tab === "blocked" ? blocked : book;
    if (tab === "buy") rows = book.filter((s) => s.action === "buy");
    if (tab === "sell") rows = book.filter((s) => s.action === "sell");
    if (tab === "hold") rows = book.filter((s) => s.action === "hold");
    const q = query.trim().toUpperCase();
    if (q) rows = rows.filter((s) => s.symbol.toUpperCase().includes(q));

    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === "symbol") return dir * a.symbol.localeCompare(b.symbol);
      const av = (a[sortKey] as number | null | undefined) ?? -Infinity;
      const bv = (b[sortKey] as number | null | undefined) ?? -Infinity;
      if (av === bv) return Math.abs(b.score) - Math.abs(a.score);
      return dir * (av - bv);
    });
  }, [book, blocked, tab, query, sortKey, sortDir]);

  const ageSec = lastSignalRefreshAt
    ? Math.max(0, Math.floor((now - lastSignalRefreshAt) / 1000))
    : null;
  const age =
    ageSec == null ? "—" : ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  const cadence =
    signalRefreshSec < 60
      ? `${Math.max(1, Math.round(signalRefreshSec))}s`
      : `${Math.max(1, Math.round(signalRefreshSec / 60))}m`;

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "all", label: "All", count: book.length },
    { id: "buy", label: "Buys", count: book.filter((s) => s.action === "buy").length },
    { id: "sell", label: "Sells", count: book.filter((s) => s.action === "sell").length },
    { id: "hold", label: "Hold", count: book.filter((s) => s.action === "hold").length },
    { id: "blocked", label: "Skipped", count: blocked.length },
  ];

  return (
    <div className="glass-raised overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border-dim">
        <div className="flex items-center gap-2.5 min-w-0">
          <Radar className="size-4 text-cyan shrink-0" />
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Signal Monitor
          </h3>
          <span className="text-[11px] font-mono text-text-muted">
            {filtered.length} names · live {age} · every {cadence}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "text-[10px] font-mono px-2 py-1 rounded-md border",
                tab === t.id
                  ? "border-cyan/40 text-cyan bg-cyan/10"
                  : "border-border-dim text-text-muted hover:text-text-secondary"
              )}
            >
              {t.label} {t.count}
            </button>
          ))}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="NVDAB"
              className="w-28 bg-surface border border-border-dim rounded-md py-1 pl-6 pr-6 text-[11px] font-mono focus:outline-none focus:border-cyan/40"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div
        className={cn(
          "px-4 py-2.5 border-b border-border-dim flex flex-wrap items-start gap-x-4 gap-y-1",
          session === "rth" && "bg-neon/[0.04]",
          session === "close" && "bg-cyan/[0.05]",
          session === "overnight" && "bg-warning/[0.05]"
        )}
      >
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
            Session edge
          </div>
          <div className="text-[13px] font-semibold text-text-primary">{playbook.title}</div>
        </div>
        <p className="text-[11px] text-text-secondary max-w-3xl leading-relaxed">
          {playbook.detail}
        </p>
      </div>

      <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
        <table className="w-full min-w-[1280px] border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-raised">
            <tr className="border-b border-border-dim">
              <Th label="Score" sortKey="score" current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Symbol" sortKey="symbol" current={sortKey} dir={sortDir} onSort={handleSort} align="left" />
              <Th label="Action" align="left" />
              <Th label="Price" sortKey="price" current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="24h" sortKey="change24h" current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="RSI" sortKey="rsi" current={sortKey} dir={sortDir} onSort={handleSort} title="RSI-14" />
              <Th label="Stoch" sortKey="stochRsi" current={sortKey} dir={sortDir} onSort={handleSort} title="Stochastic RSI" />
              <Th label="MACD" sortKey="macd" current={sortKey} dir={sortDir} onSort={handleSort} title="MACD histogram %" />
              <Th label="BB%" sortKey="bbPosition" current={sortKey} dir={sortDir} onSort={handleSort} title="Bollinger band position" />
              <Th label="VWAP" sortKey="vwapDev" current={sortKey} dir={sortDir} onSort={handleSort} title="Deviation from session VWAP" />
              <Th label="Gap" sortKey="gapPct" current={sortKey} dir={sortDir} onSort={handleSort} title="vs last NYSE close" />
              <Th label="ORB" sortKey="orbBreakoutPct" current={sortKey} dir={sortDir} onSort={handleSort} title="Opening range (first 30m RTH)" />
              <Th label="ATR" sortKey="atrPct" current={sortKey} dir={sortDir} onSort={handleSort} title="ATR as % of price" />
              <Th label="Vol" sortKey="volumeRatio" current={sortKey} dir={sortDir} onSort={handleSort} title="Volume vs 20-period average" />
              <Th label="News" sortKey="newsScore" current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Edge" align="left" title="How this name uses cash-market hours" />
              <Th label="Conf" sortKey="confidence" current={sortKey} dir={sortDir} onSort={handleSort} />
              {!readOnly && <Th label="" />}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={18} className="px-4 py-10 text-center text-[12px] font-mono text-text-muted">
                  {tab === "blocked" ? "No skipped names." : "Waiting for market pulse…"}
                </td>
              </tr>
            ) : (
              filtered.map((signal, i) => {
                const price =
                  signal.livePrice && signal.livePrice > 0 ? signal.livePrice : signal.price;
                const chg = signal.liveChange24h ?? signal.change24h;
                const edge = stockEdge(signal, asSession(signal.session ?? session));
                const hasAi = !!signal.aiSummary;
                const expanded = openAi === signal.symbol;
                return (
                  <Fragment key={signal.symbol}>
                    <tr
                      className={cn(
                        "border-b border-border-dim/60 hover:bg-surface-overlay/50",
                        i % 2 === 0 && "bg-surface-overlay/20",
                        signal.blacklisted && "opacity-50",
                        hasAi && "cursor-pointer"
                      )}
                      onClick={() => hasAi && setOpenAi(expanded ? null : signal.symbol)}
                    >
                      <Td hot={signal.score >= 20} cold={signal.score <= -20}>
                        {signal.score > 0 ? "+" : ""}
                        {Math.round(signal.score)}
                      </Td>
                      <Td align="left" className="text-text-primary">
                        <div className="flex items-center gap-2">
                          <TokenLogo symbol={signal.symbol} icon={signal.icon} />
                          <span className="font-semibold tracking-tight">{signal.symbol}</span>
                          {hasAi && <ChevronDown className={cn("size-3 text-text-muted transition-transform", expanded && "rotate-180")} />}
                        </div>
                      </Td>
                      <Td align="left">
                        <ActionBadge strength={signal.strength} />
                      </Td>
                      <Td>{formatTokenPrice(price)}</Td>
                      <Td hot={chg >= 0} cold={chg < 0}>
                        {formatPct(chg)}
                      </Td>
                      <Td hot={signal.rsi < 30} cold={signal.rsi > 70}>
                        {fmt(signal.rsi, 0)}
                      </Td>
                      <Td hot={(signal.stochRsi ?? 50) < 20} cold={(signal.stochRsi ?? 50) > 80}>
                        {fmt(signal.stochRsi, 0)}
                      </Td>
                      <Td hot={(signal.macd ?? 0) > 0} cold={(signal.macd ?? 0) < 0}>
                        {signed(signal.macd, 2)}
                      </Td>
                      <Td hot={(signal.bbPosition ?? 50) <= 25} cold={(signal.bbPosition ?? 50) >= 75}>
                        {fmt(signal.bbPosition, 0)}
                      </Td>
                      <Td hot={(signal.vwapDev ?? 0) > 0} cold={(signal.vwapDev ?? 0) < 0}>
                        {signed(signal.vwapDev, 2, "%")}
                      </Td>
                      <Td hot={(signal.gapPct ?? 0) < -1} cold={(signal.gapPct ?? 0) > 2}>
                        {signed(signal.gapPct, 2, "%")}
                      </Td>
                      <Td hot={(signal.orbBreakoutPct ?? 0) > 0.3} cold={(signal.orbBreakoutPct ?? 0) < -0.3}>
                        {signed(signal.orbBreakoutPct, 2, "%")}
                      </Td>
                      <Td>{fmt(signal.atrPct, 1, "%")}</Td>
                      <Td hot={(signal.volumeRatio ?? 0) >= 2}>
                        {fmt(signal.volumeRatio, 1, "x")}
                      </Td>
                      <Td>
                        {signal.newsArticles
                          ? `${Math.round(signal.newsScore ?? 0)}`
                          : "—"}
                      </Td>
                      <Td align="left" className={toneClass(edge.tone)}>
                        {edge.label}
                      </Td>
                      <Td>{Math.round(signal.confidence * 100)}%</Td>
                      {!readOnly && (
                        <Td>
                          {signal.blacklisted ? (
                            <button
                              type="button"
                              disabled={busySymbol === signal.symbol}
                              onClick={(e) => {
                                e.stopPropagation();
                                void (async () => {
                                  setBusySymbol(signal.symbol);
                                  try {
                                    await onUnblacklist?.(signal.symbol);
                                  } finally {
                                    setBusySymbol(null);
                                  }
                                })();
                              }}
                              className="text-[10px] text-text-muted hover:text-neon inline-flex items-center gap-1"
                            >
                              <Undo2 className="size-3" /> resume
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busySymbol === signal.symbol}
                              onClick={(e) => {
                                e.stopPropagation();
                                void (async () => {
                                  setBusySymbol(signal.symbol);
                                  try {
                                    await onBlacklist?.(signal.symbol);
                                  } finally {
                                    setBusySymbol(null);
                                  }
                                })();
                              }}
                              className="text-[10px] text-text-muted hover:text-danger inline-flex items-center gap-1"
                            >
                              <Ban className="size-3" /> skip
                            </button>
                          )}
                        </Td>
                      )}
                    </tr>
                    {expanded && signal.aiSummary && (
                      <tr key={`${signal.symbol}-ai`} className="bg-cyan/[0.04] border-b border-border-dim/60">
                        <td colSpan={18} className="px-4 py-3 text-[12px] text-text-secondary leading-relaxed">
                          <span className="text-cyan font-mono text-[10px] uppercase tracking-wider mr-2">
                            AI {signal.aiVerdict ?? "note"}
                          </span>
                          {signal.aiSummary}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
