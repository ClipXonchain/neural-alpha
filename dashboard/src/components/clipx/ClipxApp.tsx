"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  Aperture,
  Atom,
  BarChart3,
  Bell,
  Bird,
  Bot,
  Box,
  BrainCircuit,
  Cat,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clover,
  Compass,
  Crown,
  Diamond,
  ExternalLink,
  Fish,
  Flame,
  Gem,
  Ghost,
  Hexagon,
  Info,
  Layers,
  LayoutDashboard,
  Leaf,
  Menu,
  Moon,
  Mountain,
  Orbit,
  PieChart,
  Rabbit,
  RefreshCw,
  Rocket,
  Settings,
  Shell,
  Sparkles,
  Star,
  Sun,
  Swords,
  Target,
  TreePine,
  TrendingUp,
  Wallet,
  Waves,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { AgentState, Position, Signal, Trade } from "@/lib/mock-data";
import type { WalletSnapshot } from "@/lib/agent-api";
import { formatPct, formatTokenQty, formatTradePrice, formatUsd, normalizeTokenIconUrl, shortenHash, timeAgo } from "@/lib/utils";
import dynamic from "next/dynamic";
import Image from "next/image";

const EquityChart = dynamic(
  () => import("@/components/dashboard/EquityChart").then((mod) => mod.EquityChart),
  { ssr: false, loading: () => <div style={{ height: 220 }} /> }
);
const AllocationChart = dynamic(
  () => import("@/components/dashboard/AllocationChart").then((mod) => mod.AllocationChart),
  { ssr: false, loading: () => <div style={{ height: 260 }} /> }
);
import { SignalMonitor } from "@/components/dashboard/SignalMonitor";
import { AiDesk } from "@/components/dashboard/AiDesk";
import { WalletPanel } from "@/components/dashboard/WalletPanel";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { AgentControls, type DeskConfig } from "@/components/dashboard/AgentControls";

type ViewId = "overview" | "portfolio" | "agents" | "strategies" | "trades" | "intelligence" | "watchlist" | "analytics" | "wallet" | "activity" | "settings";

type LedgerRow = {
  id: string;
  symbol: string;
  status: "OPEN" | "CLOSED";
  amount: number;
  entry: number | null;
  exit: number | null;
  bought: number | null;
  sold: number | null;
  pnl: number | null;
  returnPct: number | null;
  time: number;
  source: string;
  tx: string;
};

const NAV: { id: ViewId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "portfolio", label: "Portfolio", icon: PieChart },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "strategies", label: "Strategies", icon: Target },
  { id: "trades", label: "Trades", icon: Activity },
  { id: "intelligence", label: "Intelligence", icon: BrainCircuit },
  { id: "watchlist", label: "Watchlist", icon: Star },
  { id: "activity", label: "Alerts", icon: Bell },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "wallet", label: "Wallet", icon: Wallet },
  { id: "settings", label: "Settings", icon: Settings },
];

function money(value: number | null): string {
  if (value == null) return "—";
  return value > 0 ? `+${formatUsd(value)}` : formatUsd(value);
}

function Sparkline({ values, positive = true }: { values: number[]; positive?: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 120;
    const y = 36 - ((value - min) / span) * 30;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg className={`sparkline ${positive ? "" : "negative"}`} viewBox="0 0 120 42" preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}

function WinRing({ rate }: { rate: number }) {
  const radius = 15;
  const circ = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, rate)) / 100) * circ;
  return (
    <svg className="win-ring" viewBox="0 0 42 42" aria-hidden>
      <circle cx="21" cy="21" r={radius} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="4" />
      <circle cx="21" cy="21" r={radius} fill="none" stroke="#12b264" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${dash} ${circ}`} transform="rotate(-90 21 21)" />
    </svg>
  );
}

function TokenMark({ symbol, icon, small = false }: { symbol: string; icon?: string; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (icon && !failed) {
    return (
      <img
        className={`token-logo${small ? " sm" : ""}`}
        src={icon}
        alt=""
        width={small ? 24 : 28}
        height={small ? 24 : 28}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return <span className={`token-logo fallback${small ? " sm" : ""}`}>{symbol.replace(/[^A-Z0-9]/gi, "").slice(0, 1) || "?"}</span>;
}

function buildRows(trades: Trade[]): LedgerRow[] {
  const lots = new Map<string, { amount: number; cost: number }[]>();
  const closed: LedgerRow[] = [];
  for (const trade of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
    if (trade.side === "buy") {
      const queue = lots.get(trade.symbol) ?? [];
      queue.push({ amount: trade.amount, cost: trade.total });
      lots.set(trade.symbol, queue);
      continue;
    }
    const queue = lots.get(trade.symbol) ?? [];
    let left = trade.amount;
    let matched = 0;
    while (left > 0 && queue.length > 0) {
      const lot = queue[0];
      const qty = Math.min(left, lot.amount);
      const fraction = lot.amount > 0 ? qty / lot.amount : 0;
      matched += lot.cost * fraction;
      lot.amount -= qty;
      lot.cost -= lot.cost * fraction;
      left -= qty;
      if (lot.amount <= 1e-10) queue.shift();
    }
    const pnl = trade.pnl != null && Number.isFinite(trade.pnl) ? trade.pnl : matched > 0 ? trade.total - matched : null;
    const bought = pnl != null ? Math.round((trade.total - pnl) * 100) / 100 : matched > 0 ? Math.round(matched * 100) / 100 : null;
    closed.push({
      id: trade.id,
      symbol: trade.symbol,
      status: "CLOSED",
      amount: trade.amount,
      entry: bought != null && trade.amount > 0 ? bought / trade.amount : null,
      exit: trade.price,
      bought,
      sold: trade.total,
      pnl,
      returnPct: bought && pnl != null ? (pnl / bought) * 100 : null,
      time: trade.timestamp,
      source: trade.txHash.startsWith("binance-web3-") ? "Binance Web3" : "Wallet",
      tx: trade.txHash,
    });
  }
  const open: LedgerRow[] = [];
  for (const [symbol, queue] of lots) {
    const amount = queue.reduce((sum, lot) => sum + lot.amount, 0);
    const bought = queue.reduce((sum, lot) => sum + lot.cost, 0);
    if (amount <= 1e-8) continue;
    const sourceTrade = trades
      .filter((trade) => trade.symbol === symbol && trade.side === "buy")
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    open.push({
      id: `open-${symbol}`,
      symbol,
      status: "OPEN",
      amount,
      entry: amount > 0 ? bought / amount : null,
      exit: null,
      bought,
      sold: null,
      pnl: null,
      returnPct: null,
      time: sourceTrade?.timestamp ?? Date.now(),
      source: sourceTrade?.txHash.startsWith("binance-web3-") ? "Binance Web3" : "Wallet",
      tx: sourceTrade?.txHash ?? "",
    });
  }
  return [...closed, ...open].sort((a, b) => b.time - a.time);
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = "",
  subTone = "",
  spark,
  ring,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  sub: string;
  tone?: string;
  subTone?: string;
  spark?: number[];
  ring?: number;
}) {
  const positive = tone !== "red";
  return (
    <div className="stat-card">
      <div className={`stat-icon ${tone}`}><Icon size={15} /></div>
      <div className="stat-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small className={subTone}>{sub}</small>
      </div>
      {ring != null ? <WinRing rate={ring} /> : spark && spark.length > 1 ? <Sparkline values={spark} positive={positive} /> : null}
    </div>
  );
}

function BnbMark() {
  return (
    <img
      className="bnb-mark"
      src="/brand/bnb-chain/BNB-Chain-Symbol-Yellow.svg"
      alt=""
      width={16}
      height={16}
    />
  );
}

function agentKind(session?: string): "overnight" | "rth" | "close" | "core" {
  const key = (session ?? "").toLowerCase();
  if (key.includes("overnight")) return "overnight";
  if (key.includes("close")) return "close";
  if (key.includes("rth") || key.includes("regular")) return "rth";
  return "core";
}

const DESK_AGENT = "bStocks Beta";

/** One robot face per session desk. Same family: head, eyes, antenna or visor. */
const AGENT_ROBOTS = {
  rth: { color: "#7ee7ff", face: "antenna" },
  close: { color: "#f5b942", face: "smile" },
  overnight: { color: "#3ddc97", face: "visor" },
  core: { color: "#7ee7ff", face: "antenna" },
} as const;

function AgentRobot({ session }: { session?: string }) {
  const robot = AGENT_ROBOTS[agentKind(session)];
  const color = robot.color;
  return (
    <svg className="agent-glyph" width="28" height="28" viewBox="0 0 32 32" aria-hidden>
      {robot.face === "antenna" && (
        <>
          <path d="M16 2.2v3" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="16" cy="2" r="1.45" fill={color} />
        </>
      )}
      <rect x="6.2" y="6.8" width="19.6" height="16.6" rx="5" fill="#101418" stroke={color} strokeWidth="1.6" />
      {robot.face === "visor" ? (
        <path d="M10.2 14.2h11.6" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
      ) : (
        <>
          <circle cx="12.2" cy="14.2" r="1.7" fill={color} />
          <circle cx="19.8" cy="14.2" r="1.7" fill={color} />
        </>
      )}
      <path
        d={robot.face === "smile" ? "M12 18.6c1.2 1.4 6.6 1.4 8 0" : "M12.2 19.2h7.6"}
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

const WALLET_ICONS: LucideIcon[] = [
  Aperture, Atom, Bird, Box, Cat, Clover, Compass, Crown, Diamond, Fish,
  Flame, Gem, Ghost, Hexagon, Leaf, Moon, Mountain, Orbit, Rabbit, Rocket,
  Shell, Sparkles, Sun, Swords, TreePine, Waves, Zap,
];

const WALLET_PALETTES: [string, string][] = [
  ["#d4b89a", "#6e5b4c"],
  ["#7ec8ff", "#1d4e89"],
  ["#8ef0c2", "#146b4a"],
  ["#f0c36a", "#8a5a12"],
  ["#f2a0c0", "#7a3058"],
  ["#c4b5fd", "#4c3d8f"],
  ["#f5a07a", "#8a3d22"],
  ["#9ad0d8", "#1e5c68"],
  ["#e8e4dc", "#5c5854"],
  ["#b8e07a", "#3d6b1e"],
  ["#ff9b9b", "#8a2424"],
  ["#a8c0ff", "#2a3d8a"],
];

function walletSeed(address: string): number {
  let hash = 2166136261;
  for (let i = 0; i < address.length; i++) {
    hash ^= address.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function WalletAvatar({ address }: { address?: string | null }) {
  if (!address) {
    return (
      <div className="avatar" aria-hidden>
        <Wallet size={15} strokeWidth={2.25} />
        <span />
      </div>
    );
  }
  const seed = walletSeed(address.toLowerCase());
  const Icon = WALLET_ICONS[seed % WALLET_ICONS.length];
  const [from, to] = WALLET_PALETTES[(seed >>> 8) % WALLET_PALETTES.length];
  return (
    <div className="avatar" style={{ background: `linear-gradient(145deg, ${from}, ${to})` }} aria-hidden>
      <Icon size={15} strokeWidth={2.25} />
      <span />
    </div>
  );
}

export function ClipxApp({
  state,
  wallet,
  connected,
  error,
  readOnly,
  config,
  onStart,
  onStop,
  onSync,
  onSignin,
  onVerify,
  onResync,
  onSell,
  onSave,
  onBlacklist,
  onUnblacklist,
  showcaseView,
}: {
  state: AgentState;
  wallet: WalletSnapshot | null;
  connected: boolean;
  error: string | null;
  readOnly: boolean;
  config: DeskConfig | null;
  onStart: () => void;
  onStop: () => void;
  onSync: () => Promise<{ usdtBalance: number; synced: boolean }>;
  onSignin: () => Promise<{ urlForWeb?: string; qrCodeId?: string; pairingCode?: string; status?: string }>;
  onVerify: (qrCodeId: string) => Promise<Record<string, unknown>>;
  onResync?: () => Promise<void>;
  onSell?: (symbol: string) => Promise<void>;
  onSave: (updates: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  onBlacklist?: (symbol: string) => Promise<void>;
  onUnblacklist?: (symbol: string) => Promise<void>;
  showcaseView?: ViewId;
}) {
  const [view, setView] = useState<ViewId>(showcaseView ?? "overview");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<LedgerRow | null>(null);
  const [range, setRange] = useState<keyof typeof RANGES>("30D");
  const rows = useMemo(() => buildRows(state.trades), [state.trades]);
  const title = NAV.find((item) => item.id === view)?.label ?? "Overview";
  const address = wallet?.address ? shortenHash(wallet.address) : "Not connected";
  const sentiment = useMemo(() => {
    const scored = state.signals.filter((signal) => !signal.blacklisted);
    const bull = scored.filter((signal) => signal.action === "buy").length;
    const bear = scored.filter((signal) => signal.action === "sell").length;
    const neutral = Math.max(0, scored.length - bull - bear);
    const total = Math.max(1, scored.length);
    return {
      bull: Math.round((bull / total) * 100),
      bear: Math.round((bear / total) * 100),
      neutral: Math.round((neutral / total) * 100),
      label: bull > bear && bull > neutral ? "Bullish" : bear > bull && bear > neutral ? "Bearish" : "Neutral",
    };
  }, [state.signals]);

  const icons = useMemo(() => {
    const map = new Map<string, string>();
    for (const signal of state.signals) {
      if (signal.icon) map.set(signal.symbol.toUpperCase(), signal.icon);
    }
    for (const holding of wallet?.binancePositions ?? []) {
      const icon = normalizeTokenIconUrl(holding.icon);
      if (icon) map.set(holding.symbol.toUpperCase(), icon);
    }
    return map;
  }, [state.signals, wallet]);
  const curve = state.equityCurve.map((point) => point.value);
  const alertCount = state.activity.filter((item) => item.type === "risk" || item.type === "error").length;

  const go = (id: ViewId) => {
    setView(id);
    setOpen(false);
  };

  return (
    <div className={`app${showcaseView ? " showcase-app" : ""}`}>
      {!showcaseView && <button className={`sidebar-backdrop ${open ? "show" : ""}`} aria-label="Close menu" onClick={() => setOpen(false)} />}
      {!showcaseView && <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brand">
          <Image className="brand-logo" src="/brand/neural-alpha-logo.png" alt="Neural Alpha" width={960} height={300} priority sizes="208px" style={{ width: "100%", height: "auto" }} />
        </div>
        <nav>
          {NAV.filter((item) => item.id !== "settings" || !readOnly).map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${view === id ? "active" : ""}`} onClick={() => go(id)}>
              <Icon size={18} />
              <span>{label}</span>
              {id === "activity" && alertCount > 0 && <b>{alertCount > 99 ? "99+" : alertCount}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a className="about-link" href="/about">
            <Info size={18} />
            <span>About</span>
          </a>
        </div>
      </aside>}

      <main className="main">
        {!showcaseView && <header className="topbar">
          <button className="mobile-menu" onClick={() => setOpen((value) => !value)} aria-label="Open menu"><Menu size={18} /></button>
          <div className="page-title">
            <h1>{title}</h1>
            <span className="live"><i /> {connected ? "Live" : "Offline"}</span>
            {!readOnly && (
              <button className="select-button" onClick={state.status === "running" ? onStop : onStart}>
                {state.status === "running" ? "Stop" : "Start"}
              </button>
            )}
            {onResync && <button className="icon-button" onClick={() => void onResync()} aria-label="Refresh"><RefreshCw size={15} /></button>}
          </div>
          <div className="top-actions">
            <button className="select-button"><BnbMark /> BNB Chain <ChevronDown size={15} /></button>
            <button className="wallet-pill" onClick={() => go("wallet")}><Wallet size={15} /> {address} <ExternalLink size={13} /></button>
            <WalletAvatar address={wallet?.address} />
          </div>
        </header>}

        {!connected && error && <div className="page" style={{ paddingBottom: 0 }}><div className="feature-note">{error}</div></div>}

        {view === "overview" && (
          <Overview
            state={state}
            rows={rows}
            icons={icons}
            curve={curve}
            range={range}
            onRange={setRange}
            sentiment={sentiment}
            onTrade={setSelected}
            onAll={() => go("trades")}
          />
        )}
        {view === "agents" && <AgentsPage state={state} />}
        {view === "strategies" && <StrategiesPage state={state} config={config} />}
        {view === "portfolio" && (
          <div className="page">
            <div className="content-grid portfolio-grid">
              <div className="panel"><Section title="Allocation" /><AllocationChart state={state} onRefresh={onResync} /></div>
              <div className="panel"><Section title="Open Positions" /><PositionRows positions={state.positions} icons={icons} /></div>
            </div>
          </div>
        )}
        {view === "trades" && <TradesPage rows={rows} icons={icons} curve={curve} onSelect={setSelected} />}
        {view === "intelligence" && (
          <div className="page">
            <AiDesk readOnly={readOnly} />
            <SignalMonitor
              signals={state.signals}
              lastSignalRefreshAt={state.lastSignalRefreshAt}
              signalRefreshSec={state.signalRefreshSec ?? 10}
              session={state.sessionActive}
              readOnly={readOnly}
              onBlacklist={onBlacklist}
              onUnblacklist={onUnblacklist}
            />
          </div>
        )}
        {view === "watchlist" && (
          <div className="page"><div className="panel"><Section title="Market Watchlist" /><Watchlist signals={state.signals} icons={icons} /></div></div>
        )}
        {view === "wallet" && (
          <div className="page">
            <WalletPanel wallet={wallet} mode={state.mode} connected={connected} onSync={onSync} onSignin={onSignin} onVerify={onVerify} readOnly={readOnly} />
          </div>
        )}
        {view === "activity" && (
          <div className="page">
            <ActivityFeed
              activity={state.activity}
              signals={state.signals}
              trades={state.trades}
              held={state.positions.map((position) => position.symbol)}
              icons={icons}
            />
          </div>
        )}
        {view === "analytics" && <AnalyticsPage state={state} config={config} />}
        {view === "settings" && !readOnly && (
          <div className="page">
            <AgentControls connected={connected} config={config} onSave={onSave} />
          </div>
        )}
      </main>
      {selected && <TradeDrawer row={selected} icon={icons.get(selected.symbol.toUpperCase())} onClose={() => setSelected(null)} />}
    </div>
  );
}

function sentOutUsd(state: AgentState): number {
  return (state.externalFlows ?? []).filter((f) => f.direction === "out").reduce((sum, f) => sum + f.valueUsd, 0);
}

function portfolioBasisLabel(state: AgentState): string {
  if (!(state.initialNavUsd > 0)) return "Live wallet value";
  const out = sentOutUsd(state);
  return out > 0
    ? `Deposit ${formatUsd(state.initialNavUsd)} · ${formatUsd(out)} sent out`
    : `Deposit ${formatUsd(state.initialNavUsd)}`;
}

function uptimeLabel(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function AgentsPage({ state }: { state: AgentState }) {
  const auto = state.autonomous;
  const up = state.totalPnl >= 0;
  const facts = [
    ["Phase", auto.phase],
    ["Session", `${auto.sessionLabel}${auto.nyTimeLabel ? ` · ${auto.nyTimeLabel}` : ""}`],
    ["Uptime", uptimeLabel(state.uptime)],
    ["Trades today", String(auto.tradesToday)],
    ["Next cycle", auto.nextCycleInSec == null ? "—" : `${auto.nextCycleInSec}s`],
    ["Mode", state.mode],
  ];
  return (
    <div className="page">
      <div className="panel" style={{ marginBottom: 12 }}>
        <Section title="Active AI Agents" />
        <div className="agent-list">
          <div className="agent-row">
            <div className={`agent-status ${state.status === "running" ? "" : "warn"}`} />
            <div className={`agent-avatar ${agentKind(auto.sessionLabel)}`}><AgentRobot session={auto.sessionLabel} /></div>
            <div className="agent-info"><strong>{DESK_AGENT}</strong><small>On-chain US stocks · {auto.sessionLabel}</small></div>
            <div className="agent-state">
              <b className={state.status === "running" ? "monitoring" : "idle"}>{state.status === "running" ? auto.phase.toUpperCase() : "IDLE"}</b>
              <small>Risk: {state.emergencyMode ? "High" : "Low"}</small>
            </div>
            <div className={`agent-pnl ${up ? "" : "negative"}`}>{money(state.totalPnl)}<small>{formatPct(state.totalPnlPct)}</small></div>
          </div>
        </div>
        <div className="panel-footer"><span>Total Agents P&L (Today)</span><strong>{money(state.dailyPnl)}</strong></div>
      </div>
      <div className="rule-grid">
        {facts.map(([label, value]) => (
          <div className="rule-card" key={label}><span>{label}</span><strong>{value}</strong></div>
        ))}
      </div>
    </div>
  );
}

function StrategiesPage({ state, config }: { state: AgentState; config: DeskConfig | null }) {
  const auto = state.autonomous;
  const rules: Array<[string, string, string]> = [
    ["Universe", "bStock", "Tokenized US stocks with the B suffix"],
    ["Max position", config ? formatUsd(config.maxPositionSizeUsd) : "—", "Largest single entry"],
    ["Open book", config ? `${config.maxPortfolioTokens} tokens` : `${state.maxPositionsLimit} tokens`, "How many names can be held"],
    ["Stop loss", state.stopLossPct != null ? `${state.stopLossPct}%` : "—", "Exit when a lot is down this far"],
    ["Take profit", state.takeProfitPct != null ? `${state.takeProfitPct}%` : "—", "Exit when a lot is up this far"],
    ["Trailing", state.trailingGivebackPct != null ? `${state.trailingGivebackPct}% giveback` : "—", state.trailingActivatePct != null ? `Arms after +${state.trailingActivatePct}%` : "Trailing exit"],
    ["Slippage", config ? `${config.slippageTolerance}%` : "—", "Market-order tolerance"],
    ["Session", auto.sessionPolicy, `${auto.sessionLabel} clock`],
    ["Auto exit", auto.autoExitEnabled ? "On" : "Off", "Closes lots when a rule hits"],
  ];
  return (
    <div className="page">
      <div className="panel" style={{ marginBottom: 12 }}>
        <Section title="bStock strategy" />
        <div className="agent-list">
          <div className="agent-row">
            <div className="agent-status" />
            <div className={`agent-avatar ${agentKind(auto.sessionLabel)}`}><AgentRobot session={auto.sessionLabel} /></div>
            <div className="agent-info"><strong>{DESK_AGENT}</strong><small>On-chain US stocks · {auto.sessionLabel}</small></div>
            <div className="agent-state"><b className="monitoring">LIVE</b><small>{state.mode}</small></div>
          </div>
        </div>
      </div>
      <div className="rule-grid">
        {rules.map(([label, value, note]) => (
          <div className="rule-card" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
        ))}
      </div>
    </div>
  );
}

function AnalyticsPage({ state, config }: { state: AgentState; config: DeskConfig | null }) {
  const buys = state.trades.filter((trade) => trade.side === "buy");
  const sells = state.trades.filter((trade) => trade.side === "sell");
  const boughtUsd = buys.reduce((sum, trade) => sum + trade.total, 0);
  const soldUsd = sells.reduce((sum, trade) => sum + trade.total, 0);
  const outflow = (state.externalFlows ?? []).filter((flow) => flow.direction === "out");
  const outflowUsd = sentOutUsd(state);
  const dust = state.trades.filter((trade) => trade.total > 0 && trade.total <= 5);
  const closed = sells.filter((trade) => trade.pnl != null && Number.isFinite(trade.pnl));
  const best = closed.reduce<Trade | null>((pick, trade) => (pick == null || (trade.pnl ?? 0) > (pick.pnl ?? 0) ? trade : pick), null);
  const worst = closed.reduce<Trade | null>((pick, trade) => (pick == null || (trade.pnl ?? 0) < (pick.pnl ?? 0) ? trade : pick), null);
  const wins = closed.filter((trade) => (trade.pnl ?? 0) > 0);
  const losses = closed.filter((trade) => (trade.pnl ?? 0) < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
  const grossLoss = losses.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const profitFactor = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null;
  const deposit = config?.initialDepositUsd && config.initialDepositUsd > 0 ? config.initialDepositUsd : state.initialNavUsd;
  const openCost = state.positions.reduce((sum, position) => sum + position.entryPrice * position.amount, 0);
  const largestBuy = buys.reduce<Trade | null>((pick, trade) => (pick == null || trade.total > pick.total ? trade : pick), null);
  const largestSell = sells.reduce<Trade | null>((pick, trade) => (pick == null || trade.total > pick.total ? trade : pick), null);

  return (
    <div className="page">
      <div className="stats-grid">
        <StatCard icon={TrendingUp} label="Bought" value={formatUsd(boughtUsd)} sub={`${buys.length} buy ${buys.length === 1 ? "trade" : "trades"}`} />
        <StatCard icon={Activity} label="Sold" value={formatUsd(soldUsd)} sub={`${sells.length} sell ${sells.length === 1 ? "trade" : "trades"}`} tone="red" />
        <StatCard icon={Wallet} label="USDT deposited" value={formatUsd(deposit)} sub="Transfer in" />
        <StatCard icon={Layers} label="Transfer out" value={formatUsd(outflowUsd)} sub={outflow.length ? outflow.map((flow) => flow.symbol).join(", ") + " · not counted as loss" : "No transfers out"} />
      </div>
      <div className="stats-grid">
        <StatCard icon={CircleDollarSign} label="Highest profit" value={best ? money(best.pnl ?? 0) : "—"} sub={best ? best.symbol : "No closed trade"} subTone="gain" />
        <StatCard icon={BarChart3} label="Highest loss" value={worst ? money(worst.pnl ?? 0) : "—"} sub={worst ? worst.symbol : "No closed trade"} tone="red" subTone="loss" />
        <StatCard icon={TrendingUp} label="Average win" value={wins.length ? money(avgWin) : "—"} sub={`${wins.length} winning closes`} subTone={wins.length ? "gain" : ""} />
        <StatCard icon={Activity} label="Average loss" value={losses.length ? money(avgLoss) : "—"} sub={`${losses.length} losing closes`} tone="red" subTone={losses.length ? "loss" : ""} />
      </div>
      <div className="rule-grid" style={{ marginBottom: 12 }}>
        <div className="rule-card"><span>Realized P&L</span><strong className={state.realizedPnl < 0 ? "loss" : "gain"}>{money(state.realizedPnl)}</strong><small>{state.closedTrades} closed trades</small></div>
        <div className="rule-card"><span>Unrealized P&L</span><strong className={state.unrealizedPnl < 0 ? "loss" : "gain"}>{money(state.unrealizedPnl)}</strong><small>{formatUsd(openCost)} still open</small></div>
        <div className="rule-card"><span>Win rate</span><strong>{closed.length ? `${((wins.length / closed.length) * 100).toFixed(1)}%` : "—"}</strong><small>{wins.length} wins · {losses.length} losses</small></div>
        <div className="rule-card"><span>Profit factor</span><strong>{profitFactor == null ? "—" : profitFactor.toFixed(2)}</strong><small>Gross profit ÷ gross loss</small></div>
        <div className="rule-card"><span>Gross profit</span><strong className="gain">{money(grossProfit)}</strong><small>Sum of winning closes</small></div>
        <div className="rule-card"><span>Gross loss</span><strong className="loss">{money(grossLoss)}</strong><small>Sum of losing closes</small></div>
        <div className="rule-card"><span>Max drawdown</span><strong>{state.maxDrawdownPct.toFixed(2)}%</strong><small>Current {state.currentDrawdownPct.toFixed(2)}%</small></div>
        <div className="rule-card"><span>Largest buy</span><strong>{largestBuy ? formatUsd(largestBuy.total) : "—"}</strong><small>{largestBuy ? largestBuy.symbol : "No buy yet"}</small></div>
        <div className="rule-card"><span>Largest sell</span><strong>{largestSell ? formatUsd(largestSell.total) : "—"}</strong><small>{largestSell ? largestSell.symbol : "No sell yet"}</small></div>
        <div className="rule-card"><span>Dust left out</span><strong>{dust.length}</strong><small>{formatUsd(dust.reduce((sum, trade) => sum + trade.total, 0))} at $5 or below</small></div>
        <div className="rule-card"><span>Cash</span><strong>{formatUsd(state.cashBalance)}</strong><small>Gas reserve {formatUsd(state.gasReserveUsd)}</small></div>
        <div className="rule-card"><span>Trades today</span><strong>{state.todayTrades}</strong><small>{state.totalTrades} confirmed in the book</small></div>
      </div>
      <div className="panel chart-panel">
        <div className="section-header"><h2>Portfolio Performance</h2></div>
        <EquityChart state={state} embedded />
      </div>
    </div>
  );
}

function Section({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="section-header">
      <h2>{title}</h2>
      {action && <button className="ghost-button" onClick={onAction}>{action}<ChevronRight size={14} /></button>}
    </div>
  );
}

const RANGES = {
  "1D": 86_400_000,
  "7D": 7 * 86_400_000,
  "30D": 30 * 86_400_000,
  "90D": 90 * 86_400_000,
  "1Y": 365 * 86_400_000,
  ALL: undefined,
} as const;

function Overview({
  state,
  rows,
  icons,
  curve,
  range,
  onRange,
  sentiment,
  onTrade,
  onAll,
}: {
  state: AgentState;
  rows: LedgerRow[];
  icons: Map<string, string>;
  curve: number[];
  range: keyof typeof RANGES;
  onRange: (range: keyof typeof RANGES) => void;
  sentiment: { bull: number; bear: number; neutral: number; label: string };
  onTrade: (row: LedgerRow) => void;
  onAll: () => void;
}) {
  const up = state.totalPnl >= 0;
  return (
    <div className="page">
      <div className="stats-grid five">
        <StatCard icon={Wallet} label="Total Portfolio Value" value={formatUsd(state.portfolioValue)} sub={portfolioBasisLabel(state)} spark={curve} />
        <StatCard icon={CircleDollarSign} label="Total P&L" value={money(state.totalPnl)} sub={`${formatPct(state.totalPnlPct)} all time`} tone={state.totalPnl < 0 ? "red" : ""} subTone={state.totalPnl < 0 ? "loss" : "gain"} />
        <StatCard icon={TrendingUp} label="Today's P&L" value={money(state.dailyPnl)} sub={formatPct(state.dailyPnlPct)} tone={state.dailyPnl < 0 ? "red" : ""} subTone={state.dailyPnl < 0 ? "loss" : "gain"} spark={curve.slice(-24)} />
        <StatCard icon={Layers} label="Open Positions" value={String(state.positions.length)} sub={`Across ${state.positions.length} assets`} tone="blue" />
        <StatCard icon={Activity} label="Win Rate (All Time)" value={`${state.winRate.toFixed(1)}%`} sub={`${state.winCount} of ${state.closedTrades} closes`} ring={state.winRate} />
      </div>
      <div className="content-grid">
        <div className="main-col">
          <div className="panel chart-panel">
            <div className="section-header">
              <div>
                <h2>Portfolio Performance</h2>
                <div className="chart-value">{formatUsd(state.portfolioValue)} <span className={up ? "" : "loss"}>{money(state.totalPnl)} ({formatPct(state.totalPnlPct)})</span></div>
              </div>
              <div className="range-tabs">
                {(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((key) => (
                  <button key={key} className={range === key ? "active" : ""} onClick={() => onRange(key)}>{key === "ALL" ? "All" : key}</button>
                ))}
              </div>
            </div>
            <EquityChart state={state} embedded rangeMs={RANGES[range]} />
          </div>
          <div className="panel">
            <Section title="Recent Trades" action="View all" onAction={onAll} />
            <TradeTable rows={rows.slice(0, 6)} icons={icons} onSelect={onTrade} />
          </div>
          <div className="panel">
            <Section title="Open Positions" />
            <PositionRows positions={state.positions} icons={icons} />
          </div>
        </div>
        <div className="side-col">
          <div className="panel">
            <Section title="Active AI Agents" />
            <div className="agent-list">
              <div className="agent-row">
                <div className={`agent-status ${state.status === "running" ? "" : "warn"}`} />
                <div className={`agent-avatar ${agentKind(state.autonomous.sessionLabel)}`}><AgentRobot session={state.autonomous.sessionLabel} /></div>
                <div className="agent-info"><strong>{DESK_AGENT}</strong><small>On-chain US stocks · {state.autonomous.sessionLabel}</small></div>
                <div className="agent-state"><b className={state.status === "running" ? "monitoring" : "idle"}>{state.status === "running" ? "RUNNING" : "IDLE"}</b><small>Risk: {state.emergencyMode ? "High" : "Low"}</small></div>
                <div className={`agent-pnl ${up ? "" : "negative"}`}>{money(state.totalPnl)}<small>{formatPct(state.totalPnlPct)}</small></div>
                <ChevronRight size={15} className="muted-icon" />
              </div>
            </div>
            <div className="panel-footer"><span>Total Agents P&L (Today)</span><strong>{money(state.dailyPnl)}</strong></div>
          </div>
          <div className="panel">
            <Section title="Market Watchlist" />
            <Watchlist signals={state.signals} icons={icons} />
          </div>
          <div className="panel sentiment">
            <Section title="Market Overview" />
            <p>Market sentiment is <strong>{sentiment.label}</strong></p>
            <div className="sentiment-bar">
              <span style={{ width: `${sentiment.bear}%` }} />
              <i style={{ width: `${sentiment.neutral}%` }} />
              <b style={{ width: `${sentiment.bull}%` }} />
            </div>
            <div className="sentiment-labels">
              <span>{sentiment.bear}%<small>Bearish</small></span>
              <span>{sentiment.neutral}%<small>Neutral</small></span>
              <span>{sentiment.bull}%<small>Bullish</small></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TradeTable({ rows, icons, onSelect }: { rows: LedgerRow[]; icons: Map<string, string>; onSelect: (row: LedgerRow) => void }) {
  return (
    <div className="trade-table-wrap">
      <div className="trade-head">
        <span>Asset</span><span>Side</span><span>Entry / Buy</span><span>Exit / Sell</span><span>P&L</span><span>P&L %</span><span>Time</span><span>Source</span>
      </div>
      {rows.map((row) => (
        <button className="trade-row" key={row.id} onClick={() => onSelect(row)}>
          <div className="asset-cell">
            <TokenMark symbol={row.symbol} icon={icons.get(row.symbol.toUpperCase())} />
            <div><strong>{row.symbol}</strong><small>{formatTokenQty(row.amount)}</small></div>
          </div>
          <div>
            <b className={`tag ${row.status === "OPEN" ? "buy-tag" : "sell-tag"}`}>{row.status === "OPEN" ? "BUY" : "SELL"}</b>
            {row.status === "OPEN" && <b className="tag open-tag">OPEN</b>}
          </div>
          <div><strong>{formatTokenQty(row.amount)}</strong><small>{row.entry != null ? formatTradePrice(row.entry) : "—"}</small></div>
          <div>{row.exit != null ? <><strong>{formatTokenQty(row.amount)}</strong><small>{formatTradePrice(row.exit)}</small></> : "—"}</div>
          <div>{row.pnl != null ? <strong className={row.pnl >= 0 ? "gain" : "loss"}>{money(row.pnl)}</strong> : "—"}</div>
          <div>{row.returnPct != null ? <strong className={row.returnPct >= 0 ? "gain" : "loss"}>{formatPct(row.returnPct)}</strong> : "—"}</div>
          <div><strong>{timeAgo(row.time)}</strong></div>
          <div className="source"><span>◆</span>{row.source}<ExternalLink size={12} /></div>
        </button>
      ))}
    </div>
  );
}

function PositionRows({ positions, icons }: { positions: Position[]; icons: Map<string, string> }) {
  if (positions.length === 0) return <div className="panel-footer">No open positions</div>;
  const known = positions.filter((position) => position.entryPrice > 0 && !position.entryUnknown);
  const unrealized = known.reduce((sum, position) => sum + position.pnl, 0);
  const missing = positions.length - known.length;
  return (
    <>
      <div className="positions-table">
        <div className="pos-head">
          <span>Asset</span><span>Side</span><span>Entry</span><span>Now</span><span>Value</span><span>P&L</span>
        </div>
        {positions.map((position) => {
          const value = position.amount * position.currentPrice;
          const cost = position.entryPrice > 0 ? position.amount * position.entryPrice : null;
          const unknown = Boolean(position.entryUnknown) || position.entryPrice <= 0;
          const tone = position.pnl >= 0 ? "gain" : "loss";
          return (
            <div className="pos-row" key={position.symbol}>
              <div className="asset-cell">
                <TokenMark symbol={position.symbol} icon={icons.get(position.symbol.toUpperCase())} />
                <div>
                  <strong>{position.symbol}</strong>
                  <small>{formatTokenQty(position.amount)}</small>
                </div>
              </div>
              <div className="pos-side"><b className="tag buy-tag">LONG</b></div>
              <div className="pos-fact pos-entry">
                <strong>{unknown ? "—" : formatTradePrice(position.entryPrice)}</strong>
                <small>{unknown ? "Entry unknown" : cost != null ? `Cost ${formatUsd(cost)}` : "Entry"}</small>
              </div>
              <div className="pos-fact pos-now">
                <strong>{formatTradePrice(position.currentPrice)}</strong>
                <small>Mark</small>
              </div>
              <div className="pos-fact pos-value">
                <strong>{formatUsd(value)}</strong>
                <small>{position.weight > 0 ? `${position.weight.toFixed(1)}% of book` : "Market value"}</small>
              </div>
              <div className="pos-pnl">
                <strong className={unknown ? "" : tone}>{unknown ? "—" : money(position.pnl)}</strong>
                <small className={unknown ? "" : tone}>{unknown ? "No cost basis" : formatPct(position.pnlPct)}</small>
              </div>
            </div>
          );
        })}
      </div>
      <div className="panel-footer">
        <span>{positions.length} open{missing > 0 ? ` · ${missing} without an entry` : ""}</span>
        <strong className={known.length && unrealized < 0 ? "loss" : ""}>{known.length ? money(unrealized) : "—"}</strong>
      </div>
    </>
  );
}

function Watchlist({ signals, icons }: { signals: Signal[]; icons: Map<string, string> }) {
  const rows = [...signals].filter((signal) => !signal.blacklisted).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 8);
  return (
    <>
      <div className="watch-head"><span>Asset</span><span>Price</span><span>24h</span><span>Trend</span></div>
      {rows.map((signal) => {
        const change = signal.liveChange24h ?? signal.change24h;
        return (
          <div className="watch-row" key={signal.symbol}>
            <div className="coin"><TokenMark symbol={signal.symbol} icon={signal.icon || icons.get(signal.symbol.toUpperCase())} /><div><strong>{signal.symbol}</strong><small>{signal.action}</small></div></div>
            <strong>{formatTradePrice(signal.livePrice ?? signal.price)}</strong>
            <strong className={change >= 0 ? "gain" : "loss"}>{formatPct(change)}</strong>
            <Sparkline values={change >= 0 ? [1, 1.2, 1.1, 1.4, 1.8] : [1.8, 1.5, 1.6, 1.2, 0.9]} positive={change >= 0} />
          </div>
        );
      })}
    </>
  );
}

function TradesPage({ rows, icons, curve, onSelect }: { rows: LedgerRow[]; icons: Map<string, string>; curve: number[]; onSelect: (row: LedgerRow) => void }) {
  const bought = rows.reduce((sum, row) => sum + (row.bought ?? 0), 0);
  const sold = rows.reduce((sum, row) => sum + (row.sold ?? 0), 0);
  const pnl = rows.reduce((sum, row) => sum + (row.pnl ?? 0), 0);
  const closed = rows.filter((row) => row.pnl != null);
  const wins = closed.filter((row) => (row.pnl ?? 0) >= 0).length;
  return (
    <div className="page">
      <div className="trade-kpis">
        <StatCard icon={TrendingUp} label="Bought" value={formatUsd(bought)} sub="Cash spent" spark={curve} />
        <StatCard icon={Activity} label="Sold" value={formatUsd(sold)} sub="Cash received" tone="red" spark={curve} />
        <StatCard icon={CircleDollarSign} label="Realized P&L" value={money(pnl)} sub="Closed positions" tone={pnl < 0 ? "red" : ""} spark={curve} />
        <StatCard icon={Layers} label="Win Rate" value={closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—"} sub={`${wins} of ${closed.length} closes`} ring={closed.length ? (wins / closed.length) * 100 : 0} />
      </div>
      <div className="panel">
        <TradeTable rows={rows} icons={icons} onSelect={onSelect} />
      </div>
    </div>
  );
}

function TradeDrawer({ row, icon, onClose }: { row: LedgerRow; icon?: string; onClose: () => void }) {
  const txUrl = /^0x[a-fA-F0-9]{40,}$/.test(row.tx) ? `https://bscscan.com/tx/${row.tx}` : null;
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="detail-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div className="drawer-title">
            <TokenMark symbol={row.symbol} icon={icon} />
            <div><h2>{row.symbol} <b className="open-tag">{row.status}</b></h2><small>{timeAgo(row.time)}</small></div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="drawer-card">
          <div className="detail-grid">
            <div><span>Size</span><strong>{formatTokenQty(row.amount)}</strong></div>
            <div><span>Bought</span><strong>{row.bought != null ? formatUsd(row.bought) : "—"}</strong></div>
            <div><span>Sold</span><strong>{row.sold != null ? formatUsd(row.sold) : "—"}</strong></div>
            <div><span>P&L</span><strong className={row.pnl != null && row.pnl < 0 ? "loss" : "gain"}>{money(row.pnl)}</strong></div>
            <div><span>Return</span><strong>{row.returnPct != null ? formatPct(row.returnPct) : "—"}</strong></div>
          </div>
        </div>
        <div className="drawer-card">
          <h3>Source</h3>
          <div className="source-detail"><span>◆</span><strong>{row.source}</strong></div>
          {txUrl && <a href={txUrl} target="_blank" rel="noreferrer">{shortenHash(row.tx)}</a>}
        </div>
      </aside>
    </div>
  );
}
