"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import Image from "next/image";
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "framer-motion";
import { Search, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import {
  fetchAgentState,
  fetchLogs,
  fetchWallet,
  subscribeAgentEvents,
  type LogEntry,
  type Track1Snapshot,
  type WalletSnapshot,
} from "@/lib/agent-api";
import type { AgentState, Position, Signal, Trade } from "@/lib/mock-data";
import { enrichStateWithWallet, mapTrack1ToDashboard } from "@/lib/map-agent-state";
import { timeAgo } from "@/lib/utils";
import "./system.css";

type LiveQuote = { symbol: string; price: number | null; change24hPct: number | null; icon?: string };
type RangeKey = "1D" | "1W" | "1M" | "ALL";
type Feature = { id: "portfolio" | "agent" | "signals" | "ledger" | "wallet"; label: string; title: string; accent: string; description: string };

const features: Feature[] = [
  { id: "portfolio", label: "Portfolio", title: "See the shape", accent: "of the book.", description: "Track allocation, open exposure, and NAV history together. Select a holding to focus its share of the portfolio." },
  { id: "agent", label: "Agent and risk", title: "Every cycle has", accent: "clear guardrails.", description: "See how the agent screens opportunities, checks portfolio risk, and only then considers a route." },
  { id: "signals", label: "Market signals", title: "Read the market", accent: "name by name.", description: "Filter live bStock signals, compare technical readings, and open a row for its current context." },
  { id: "ledger", label: "Positions and fills", title: "Keep every position", accent: "in view.", description: "Move between open exposure and confirmed fills, then inspect the price, size, and realized result." },
  { id: "wallet", label: "Wallet", title: "Know what sits", accent: "behind the strategy.", description: "Explore a sample wallet with available balances and bStock holdings, arranged like the dashboard." },
];
const defaultSymbols = ["NVDAB", "AAPLB", "MSFTB", "TSLAB"];
const ranges: RangeKey[] = ["1D", "1W", "1M", "ALL"];
const sampleWalletHoldings = [
  { symbol: "NVDAB", remainQty: .8, percentChange24h: 2.4, valueUsd: 150.08 },
  { symbol: "AAPLB", remainQty: 1.2, percentChange24h: .8, valueUsd: 399.96 },
  { symbol: "MSFTB", remainQty: .7, percentChange24h: 1.2, valueUsd: 289.1 },
  { symbol: "AMZNB", remainQty: 1.05, percentChange24h: .6, valueUsd: 231 },
  { symbol: "TSLAB", remainQty: .45, percentChange24h: -.5, valueUsd: 155.7 },
];

function useLiveDesk() {
  const [snapshot, setSnapshot] = useState<Track1Snapshot | null>(null);
  const [wallet, setWallet] = useState<WalletSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  useEffect(() => {
    let active = true;
    const acceptState = (next: Track1Snapshot) => {
      if (!active) return;
      setSnapshot(next);
    };
    const acceptLog = (entry: LogEntry) => { if (active) setLogs((current) => [entry, ...current].slice(0, 8)); };
    const refresh = async () => {
      const [stateResult, walletResult, logResult] = await Promise.allSettled([fetchAgentState(), fetchWallet(), fetchLogs()]);
      if (!active) return;
      if (stateResult.status === "fulfilled") acceptState(stateResult.value);
      if (walletResult.status === "fulfilled") setWallet(walletResult.value);
      if (logResult.status === "fulfilled") setLogs(logResult.value.slice(0, 8));
    };
    void refresh();
    const unsubscribe = subscribeAgentEvents(acceptState, acceptLog);
    return () => { active = false; unsubscribe(); };
  }, []);
  return { snapshot, wallet, logs };
}

function money(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
function percent(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}
function quantity(value: number) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value); }
function price(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: value < 1 ? 4 : 2, maximumFractionDigits: value < 1 ? 6 : 2 }).format(value);
}
function elapsed(value: number | null | undefined) { return value ? timeAgo(value) : "—"; }

function useQuotes(snapshot: Track1Snapshot | null, signals: Signal[], wallet: WalletSnapshot | null, positions: Position[] = []): LiveQuote[] {
  return useMemo(() => {
    if (!snapshot) return defaultSymbols.map((symbol) => ({ symbol, price: null, change24hPct: null }));
    const live = snapshot.livePrices ?? {};
    const symbols = [...new Set([
      ...snapshot.watchlist,
      ...Object.keys(live),
      ...Object.keys(snapshot.prices),
      ...signals.map((signal) => signal.symbol),
      ...positions.map((position) => position.symbol),
      ...(wallet?.binancePositions ?? []).map((position) => position.symbol),
    ])]
      .map((symbol) => symbol.toUpperCase()).filter((symbol) => /^[A-Z0-9]{2,12}B$/.test(symbol));
    return symbols.map((symbol) => ({
      symbol,
      price: live[symbol]?.price ?? snapshot.prices[symbol] ?? null,
      change24hPct: live[symbol]?.change24hPct ?? signals.find((signal) => signal.symbol.toUpperCase() === symbol)?.change24h ?? null,
      icon: snapshot.tokenIcons?.[symbol] ?? signals.find((signal) => signal.symbol.toUpperCase() === symbol)?.icon ?? wallet?.binancePositions?.find((position) => position.symbol.toUpperCase() === symbol)?.icon,
    }));
  }, [snapshot, signals, wallet, positions]);
}

function tokenTone(symbol: string) {
  const tones = ["#48b99b", "#7f91d9", "#f0b849", "#e38376", "#5fa5cb", "#8bad59", "#bd8fc5"];
  let hash = 0;
  for (const character of symbol) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return tones[hash % tones.length];
}
function TokenLogo({ symbol, src, large = false }: { symbol: string; src?: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const short = symbol.replace(/[^A-Z0-9]/gi, "").replace(/B$/i, "").slice(0, 1) || "•";
  if (src && !failed) return <img className={`token-mark${large ? " large" : ""}`} src={src} alt="" onError={() => setFailed(true)} loading="lazy" referrerPolicy="no-referrer" />;
  return <span className={`token-mark fallback${large ? " large" : ""}`} style={{ "--token-tone": tokenTone(symbol) } as CSSProperties} aria-hidden="true">{short}</span>;
}
function BrandLogo({ className = "", priority = false }: { className?: string; priority?: boolean }) {
  return (
    <Image
      className={className}
      src="/brand/neural-alpha-logo.png"
      alt="Neural Alpha"
      width={960}
      height={300}
      priority={priority}
      sizes="160px"
      style={{ width: "100%", height: "auto" }}
    />
  );
}

type WorkflowStep = { title: string; detail: string };
function WorkflowDiagram({ label, caption, steps, className = "" }: { label: string; caption: string; steps: WorkflowStep[]; className?: string }) {
  const gradientId = `workflow-${useId().replace(/:/g, "")}`;
  const route = "M80 38H560";
  const points = [80, 240, 400, 560];
  const reduce = useReducedMotion();
  return (
    <div className={`workflow-diagram ${className}`}>
      <div className="workflow-heading"><span className="eyebrow">{label}</span><span>Illustrated flow</span></div>
      <svg className="workflow-svg" viewBox="0 0 640 78" role="img" aria-label={label}>
        <defs><linearGradient id={gradientId} x1="40" y1="38" x2="600" y2="38" gradientUnits="userSpaceOnUse"><stop stopColor="#12b264" /><stop offset="1" stopColor="#3b9eff" /></linearGradient></defs>
        <path className="workflow-rail" d={route} />
        <path className="workflow-rail-light" d={route} stroke={`url(#${gradientId})`} />
        {points.map((x, index) => <g className="workflow-node" key={x}>
          <circle className="workflow-node-halo" cx={x} cy="38" r="14" style={{ animationDelay: `${index * 180}ms` }} />
          <circle className="workflow-node-core" cx={x} cy="38" r="5" />
        </g>)}
        {!reduce && <circle className="workflow-runner" r="4.5"><animateMotion path={route} dur="5.2s" repeatCount="indefinite" /></circle>}
      </svg>
      <div className="workflow-steps">{steps.map((step, index) => <div className="workflow-step" key={step.title}>
        <span>{String(index + 1).padStart(2, "0")}</span><strong>{step.title}</strong><p>{step.detail}</p>
      </div>)}</div>
      <p className="workflow-caption">{caption}</p>
    </div>
  );
}

function NeuralBackdrop() {
  const gradientId = `brain-flow-${useId().replace(/:/g, "")}`;
  return (
    <svg className="brain-network-svg" viewBox="250 60 700 250" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="360" y1="90" x2="840" y2="280" gradientUnits="userSpaceOnUse">
          <stop stopColor="#12b264" />
          <stop offset="1" stopColor="#3b9eff" />
        </linearGradient>
        <linearGradient id={`${gradientId}-fade`} x1="600" y1="70" x2="600" y2="300" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" />
          <stop offset=".55" stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <mask id={`${gradientId}-head`}>
          <rect x="250" y="60" width="700" height="250" fill={`url(#${gradientId}-fade)`} />
        </mask>
      </defs>
      <g mask={`url(#${gradientId}-head)`}>
        <path className="brain-outline" stroke={`url(#${gradientId})`} d="M600 139c-43-43-112-52-162-20-32 21-49 58-46 95-62 11-105 65-98 127 3 27 15 50 35 68-23 58 8 128 67 148 8 3 17 5 26 6 13 57 73 91 130 72 17-6 32-17 44-31 12 14 27 25 44 31 57 19 117-15 130-72 9-1 18-3 26-6 59-20 90-90 67-148 20-18 32-41 35-68 7-62-36-116-98-127 3-37-14-74-46-95-50-32-119-23-162 20Z" />
        <path className="brain-midline" d="M600 140v150" />
        <g className="brain-folds">
          <path d="M438 218c43 5 69 31 72 69 3 34 25 48 57 51m89-181c-34 2-54 20-52 46 2 20 17 31 40 35" />
          <path d="M762 218c-43 5-69 31-72 69-3 34-25 48-57 51m-89-181c34 2 54 20 52 46-2 20-17 31-40 35" />
        </g>
      </g>
    </svg>
  );
}

function TickerPulse({ quotes, selected, onSelect }: { quotes: LiveQuote[]; selected: string; onSelect: (symbol: string) => void }) {
  const max = Math.max(1, ...quotes.map((quote) => Math.abs(quote.change24hPct ?? 0)));
  return (
    <div className="pulse-chart" role="group" aria-label="Live bStock price changes">
      <div className="pulse-grid" aria-hidden="true"><span /><span /><span /></div>
      {quotes.slice(0, 6).map((quote, index) => {
        const change = quote.change24hPct ?? 0;
        const height = 34 + Math.abs(change) / max * 98;
        return (
          <button className={`pulse-column ${selected === quote.symbol ? "selected" : ""}`} type="button" key={quote.symbol} onClick={() => onSelect(quote.symbol)} aria-pressed={selected === quote.symbol}>
            <span className={`pulse-change ${change < 0 ? "down" : "up"}`}>{percent(change)}</span>
            <TokenLogo symbol={quote.symbol} src={quote.icon} />
            <span className={`pulse-bar ${change < 0 ? "down" : ""}`} style={{ "--bar-height": `${height}px`, "--bar-tone": tokenTone(quote.symbol), "--bar-order": index } as CSSProperties} />
            <span className="pulse-symbol">{quote.symbol}</span>
          </button>
        );
      })}
      {!quotes.length && <p className="empty-state">Waiting for eligible bStock prices.</p>}
    </div>
  );
}

function Hero({ state, snapshot, quotes, selected, onSelect }: {
  state: AgentState | null; snapshot: Track1Snapshot | null;
  quotes: LiveQuote[]; selected: string; onSelect: (symbol: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const artY = useTransform(scrollYProgress, [0, 1], [0, -58]);
  const artScale = useTransform(scrollYProgress, [0, 1], [1, .95]);
  const selectedQuote = quotes.find((quote) => quote.symbol === selected);
  const tone = selectedQuote?.change24hPct != null && selectedQuote.change24hPct < 0 ? "down" : "up";
  return (
    <section className="system-hero" id="top" ref={ref}>
      <motion.div className="hero-color-orb orb-blue" style={reduce ? undefined : { y: artY, scale: artScale }} />
      <motion.div className="hero-color-orb orb-peach" style={reduce ? undefined : { y: useTransform(scrollYProgress, [0, 1], [0, -28]) }} />
      <motion.div className="hero-brain-layer" style={reduce ? undefined : { y: artY, scale: artScale }} aria-hidden="true">
        <div className="hero-brand-brain">
          <Image src="/brand/na-hero-brain.png" alt="" width={723} height={278} sizes="(max-width: 820px) 100vw, 92vw" style={{ width: "100%", height: "auto" }} />
        </div>
        <NeuralBackdrop />
      </motion.div>
      <div className="hero-layout">
        <motion.div className="hero-copy" initial={reduce ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .65, ease: [.22, .7, .3, 1] }}>
          <a className="winner-kicker" href="#winner">1st · BNB Hack Track 1</a>
          <h1>Trading logic<br /><em>you can see.</em></h1>
          <p className="hero-summary">A live bStock desk that reads the market, checks risk, and records every move.</p>
          <div className="hero-links">
            <a className="primary-link" href="#features">About the desk <span aria-hidden="true">↓</span></a>
            <a className="text-link" href="/">Open dashboard <span aria-hidden="true">↗</span></a>
          </div>
        </motion.div>

        <motion.div className="market-card" initial={reduce ? false : { opacity: 0, y: 24, scale: .975 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: .8, delay: .12, ease: [.22, .7, .3, 1] }}>
          <div className="market-card-head"><div><span className="eyebrow">Portfolio value</span><strong>{money(state?.portfolioValue ?? snapshot?.portfolio.totalValueUsd, 2)}</strong></div><div className={`market-delta ${tone}`}><span>{selectedQuote?.symbol ?? selected}</span><b>{price(selectedQuote?.price)}</b><small>{percent(selectedQuote?.change24hPct)}</small></div></div>
          <TickerPulse quotes={quotes} selected={selected} onSelect={onSelect} />
        </motion.div>
      </div>
      <a className="scroll-cue" href="#features"><span className="scroll-line" />Scroll to explore</a>
    </section>
  );
}

const track1Places = [
  { place: "1st", name: "Neural Alpha", by: "ClipX" },
  { place: "2nd", name: "Genesis" },
  { place: "3rd", name: "Gridora" },
  { place: "4th", name: "Guarded Alpha" },
  { place: "5th", name: "Superagente007" },
];

function WinnerShowcase() {
  return (
    <section className="winner-band" id="winner" aria-labelledby="winner-title">
      <div className="winner-inner">
        <div className="winner-copy">
          <p className="eyebrow">BNB Hack · Track 1</p>
          <h2 id="winner-title">Neural Alpha placed <em>first.</em></h2>
          <p>BNB Chain Developers ranked the autonomous trading agents. Five addresses shared a $24,000 pool. Neural Alpha by ClipX took the top spot.</p>
          <a className="winner-source" href="https://x.com/BNBChainDevs/status/2074807300632858776" target="_blank" rel="noreferrer">Announcement on X <span aria-hidden="true">↗</span></a>
        </div>
        <ol className="winner-board">
          {track1Places.map((entry) => (
            <li key={entry.place} className={entry.place === "1st" ? "is-first" : undefined}>
              <span>{entry.place}</span>
              <strong>{entry.name}</strong>
              {entry.by ? <small>by {entry.by}</small> : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function FeatureHeading({ feature }: { feature: Feature }) {
  return (
    <div className="feature-heading">
      <div><p className="feature-label">{feature.label}</p><h2>{feature.title} <em>{feature.accent}</em></h2></div>
      <p className="feature-description">{feature.description}</p>
    </div>
  );
}

function toChartPoints(snapshot: Track1Snapshot | null, range: RangeKey) {
  const all = snapshot?.snapshots?.filter((point) => Number.isFinite(point.totalValueUsd) && point.totalValueUsd > 0) ?? [];
  if (!all.length) return [];
  const duration: Record<Exclude<RangeKey, "ALL">, number> = { "1D": 86_400_000, "1W": 604_800_000, "1M": 2_592_000_000 };
  const selected = range === "ALL" ? all : all.filter((point) => point.timestamp >= Date.now() - duration[range]);
  return (selected.length > 1 ? selected : all).slice(-48);
}
function makeChartPath(values: number[]) {
  if (values.length < 2) return null;
  const min = Math.min(...values); const max = Math.max(...values); const span = max - min || Math.max(max * .01, 1);
  const coords = values.map((value, index) => ({ x: 24 + (index / (values.length - 1)) * 952, y: 218 - ((value - min) / span) * 184 }));
  return { coords, line: coords.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ") };
}

function InteractiveAreaChart({ snapshot, range, onRange }: { snapshot: Track1Snapshot | null; range: RangeKey; onRange: (range: RangeKey) => void }) {
  const [active, setActive] = useState<number | null>(null);
  const gradientId = `portfolio-fill-${useId().replace(/:/g, "")}`;
  const points = useMemo(() => toChartPoints(snapshot, range), [snapshot, range]);
  const values = points.map((point) => point.totalValueUsd);
  const path = makeChartPath(values);
  const activePoint = active != null && path ? path.coords[active] : null;
  const handleMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!path || !points.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 1000;
    setActive(Math.max(0, Math.min(points.length - 1, Math.round((x - 24) / 952 * (points.length - 1)))));
  };
  return (
    <div className="area-wrap">
      <div className="area-toolbar"><div><span className="eyebrow">Net asset value</span><strong>{money(points.at(-1)?.totalValueUsd ?? snapshot?.portfolio.totalValueUsd, 2)}</strong></div><div className="range-select" aria-label="Chart time range">{ranges.map((item) => <button key={item} className={range === item ? "active" : ""} onClick={() => onRange(item)} type="button">{item}</button>)}</div></div>
      <div className="area-canvas">
        {path ? <>
          <svg viewBox="0 0 1000 250" preserveAspectRatio="none" onPointerMove={handleMove} onPointerLeave={() => setActive(null)} role="img" aria-label="Interactive portfolio value history">
            <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#45c6a4" stopOpacity=".34" /><stop offset=".68" stopColor="#81cbd8" stopOpacity=".12" /><stop offset="1" stopColor="#d9eafa" stopOpacity=".015" /></linearGradient></defs>
            <path className="area-grid" d="M24 36H976M24 104H976M24 172H976M24 230H976" />
            <path className="area-fill" d={`${path.line} L976 230 L24 230 Z`} fill={`url(#${gradientId})`} />
            <path className="area-line" d={path.line} />
            {activePoint && <><path className="area-crosshair" d={`M${activePoint.x} 28V230`} /><circle className="area-active-dot" cx={activePoint.x} cy={activePoint.y} r="5" /></>}
          </svg>
          {active != null && points[active] && <div className="chart-tooltip" style={{ left: `${Math.min(88, Math.max(4, (active / Math.max(1, points.length - 1)) * 92))}%` }}><span>{new Date(points[active].timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span><b>{money(points[active].totalValueUsd)}</b></div>}
          <div className="chart-axis"><span>{points[0] ? new Date(points[0].timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}</span><span>{points.at(-1) ? new Date(points.at(-1)!.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}</span></div>
        </> : <div className="chart-empty"><span>No NAV history yet</span><p>Portfolio history appears here as the agent records account snapshots.</p></div>}
      </div>
    </div>
  );
}

function PortfolioFeature({ state, snapshot, quotes }: { state: AgentState | null; snapshot: Track1Snapshot | null; quotes: LiveQuote[] }) {
  const [range, setRange] = useState<RangeKey>("1M");
  const [focus, setFocus] = useState<string | null>(null);
  const positions = state?.positions ?? [];
  const sorted = [...positions].sort((a, b) => b.weight - a.weight);
  const focusPosition = sorted.find((position) => position.symbol === focus);
  return (
    <div className="feature-grid portfolio-grid">
      <div className="surface-card portfolio-main">
        <div className="panel-topline"><div><span className="eyebrow">Portfolio performance</span><p>Value over time</p></div><span className="subtle-value">{state ? `${state.positions.length} holdings` : "Waiting for data"}</span></div>
        <InteractiveAreaChart snapshot={snapshot} range={range} onRange={setRange} />
        <div className="allocation-foot"><span>Allocation focus</span><strong>{focusPosition?.symbol ?? "All holdings"}</strong><span>{focusPosition ? percent(focusPosition.weight, 1) : "Select a holding"}</span></div>
      </div>
      <div className="surface-card positions-card">
        <div className="panel-topline"><div><span className="eyebrow">Open positions</span><p>Current exposure</p></div><strong className="position-count">{positions.length.toString().padStart(2, "0")}</strong></div>
        <div className="position-list">
          {sorted.slice(0, 6).map((position) => {
            const quote = quotes.find((item) => item.symbol === position.symbol);
            return <button className={`position-item ${focus === position.symbol ? "active" : ""}`} key={position.symbol} onClick={() => setFocus(focus === position.symbol ? null : position.symbol)} type="button">
              <TokenLogo symbol={position.symbol} src={quote?.icon} />
              <span className="position-name"><strong>{position.symbol}</strong><small>{quantity(position.amount)} shares</small></span>
              <span className="position-meter"><i style={{ "--weight": `${Math.max(5, Math.min(position.weight, 100))}%`, "--tone": tokenTone(position.symbol) } as CSSProperties} /><small>{percent(position.weight, 1)} of book</small></span>
              <span className={`position-pnl ${position.pnl < 0 ? "negative" : "positive"}`}>{money(position.pnl)}<small>{percent(position.pnlPct)}</small></span>
            </button>;
          })}
          {!positions.length && <p className="empty-state">Open positions will appear here.</p>}
        </div>
        <div className="positions-total"><span>Unrealized P&amp;L</span><strong className={(state?.unrealizedPnl ?? 0) < 0 ? "negative" : "positive"}>{money(state?.unrealizedPnl)}</strong></div>
      </div>
    </div>
  );
}

function RiskFeature({ state }: { state: AgentState | null }) {
  const [view, setView] = useState<"cycle" | "guide">("cycle");
  const auto = state?.autonomous;
  const steps = ["Read the market", "Rank candidates", "Check risk", "Route the order"];
  const phase = (auto?.phase ?? "scanning").toLowerCase();
  const stepIndex = state?.status === "running" ? (phase.includes("risk") ? 2 : phase.includes("trade") || phase.includes("route") ? 3 : phase.includes("rank") ? 1 : 0) : -1;
  return (
    <div className="feature-grid risk-grid">
      <div className="surface-card cycle-card">
        <div className="panel-topline"><div><span className="eyebrow">Decision cycle</span><p>From scan to execution</p></div><span className={`agent-state ${state?.status === "running" ? "running" : "paused"}`}><i />{state?.status === "running" ? "Running" : "Standby"}</span></div>
        <div className="cycle-track">
          {steps.map((step, index) => <div className={`cycle-step ${stepIndex === index ? "current" : ""} ${stepIndex > index ? "done" : ""}`} key={step}>
            <span className="cycle-step-number">{String(index + 1).padStart(2, "0")}</span><span className="cycle-step-dot" /><strong>{step}</strong>{index < steps.length - 1 && <i className="cycle-connector" />}
          </div>)}
        </div>
        <div className="cycle-note"><Sparkles size={16} /><div><strong>{auto?.headline ?? "Market analysis is ready when the agent connects."}</strong><span>{auto?.sessionLabel ?? "Waiting for session"}{auto?.nextCycleInSec != null ? ` · next scan in ${auto.nextCycleInSec}s` : ""}</span></div></div>
        <div className="cycle-controls"><button type="button" className={view === "cycle" ? "active" : ""} onClick={() => setView("cycle")}>Decision flow</button><button type="button" className={view === "guide" ? "active" : ""} onClick={() => setView("guide")}>Risk guide</button></div>
      </div>
      <div className="surface-card risk-detail">
        {view === "cycle" ? <>
          <div className="panel-topline"><div><span className="eyebrow">Risk review</span><p>Checks that gate a route</p></div><ShieldCheck size={18} /></div>
          <div className="risk-principles">
            <RiskPrinciple number="01" title="Review the book" detail="Read open exposure and account readiness before a candidate advances." />
            <RiskPrinciple number="02" title="Size with context" detail="Compare the order with available capital and the existing portfolio." />
            <RiskPrinciple number="03" title="Plan the position" detail="Keep protective exits and outcome tracking attached to each fill." />
          </div>
          <div className="route-condition"><ShieldCheck size={15} /><span>Only candidates that pass every check continue to order routing.</span></div>
        </> : <>
          <div className="panel-topline"><div><span className="eyebrow">Risk framework</span><p>What gets checked before a route</p></div><ShieldCheck size={18} /></div>
          <div className="guardrail-list">
            <Guardrail number="01" title="Size for the portfolio" detail="Compare a candidate order with available balance and existing exposure." />
            <Guardrail number="02" title="Set a loss boundary" detail="Define the conditions that would close a position before entry." />
            <Guardrail number="03" title="Plan the exit" detail="Use a target and protective follow-through to manage an open position." />
            <Guardrail number="04" title="Recheck capacity" detail="Review open holdings and account readiness before routing." />
          </div>
        </>}
      </div>
    </div>
  );
}
function RiskPrinciple({ number, title, detail }: { number: string; title: string; detail: string }) {
  return <div className="risk-principle"><span>{number}</span><div><strong>{title}</strong><small>{detail}</small></div><i aria-hidden="true" /></div>;
}
function Guardrail({ number, title, detail }: { number: string; title: string; detail: string }) {
  return <div className="guardrail-row"><span>{number}</span><div><strong>{title}</strong><small>{detail}</small></div><i aria-hidden="true" /></div>;
}

function SignalFeature({ state, quotes }: { state: AgentState | null; quotes: LiveQuote[] }) {
  const [filter, setFilter] = useState<"all" | "buy" | "hold" | "sell">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const signals = state?.signals ?? [];
  const filtered = useMemo(() => signals.filter((signal) => (filter === "all" || signal.action === filter) && signal.symbol.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 8), [signals, filter, search]);
  const active = filtered.find((signal) => signal.symbol === selected) ?? filtered[0] ?? signals.find((signal) => signal.symbol === selected) ?? null;
  const activeQuote = quotes.find((quote) => quote.symbol === active?.symbol);
  return (
    <div className="feature-grid signal-grid">
      <div className="surface-card signal-browser">
        <div className="signal-tools"><div className="signal-filters">{(["all", "buy", "hold", "sell"] as const).map((item) => <button type="button" key={item} onClick={() => setFilter(item)} className={filter === item ? "active" : ""}>{item === "all" ? "All signals" : `${item[0].toUpperCase()}${item.slice(1)}s`}<span>{item === "all" ? signals.length : signals.filter((signal) => signal.action === item).length}</span></button>)}</div><label className="signal-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a ticker" aria-label="Find a ticker" /></label></div>
        <div className="signal-list">
          {filtered.map((signal) => {
            const quote = quotes.find((item) => item.symbol === signal.symbol);
            return <button className={`signal-row ${active?.symbol === signal.symbol ? "selected" : ""}`} key={signal.symbol} onClick={() => setSelected(signal.symbol)} type="button">
              <TokenLogo symbol={signal.symbol} src={signal.icon ?? quote?.icon} />
              <span className="signal-symbol"><strong>{signal.symbol}</strong><small>{signal.regime?.replaceAll("_", " ") ?? "bStock"}</small></span>
              <span className="signal-price"><strong>{price(signal.livePrice ?? signal.price)}</strong><small className={(signal.liveChange24h ?? signal.change24h) < 0 ? "negative" : "positive"}>{percent(signal.liveChange24h ?? signal.change24h)}</small></span>
              <span className="signal-score"><i><b style={{ width: `${Math.min(100, Math.abs(signal.score))}%` }} /></i><strong>{signal.score > 0 ? "+" : ""}{signal.score}</strong></span>
              <span className={`signal-action ${signal.action}`}>{signal.action}</span>
              <span className="row-arrow">↗</span>
            </button>;
          })}
          {!filtered.length && <div className="empty-state">No signals match this view.</div>}
        </div>
        <div className="signal-list-foot"><span>Updated {elapsed(state?.lastSignalRefreshAt)}</span><span>{state?.signalRefreshSec ?? 10}s refresh</span></div>
      </div>
      <div className="surface-card signal-detail">
        {active ? <>
          <div className="signal-detail-title"><TokenLogo symbol={active.symbol} src={active.icon ?? activeQuote?.icon} large /><div><span className="eyebrow">Selected bStock</span><h3>{active.symbol}</h3></div><span className={`signal-action ${active.action}`}>{active.action}</span></div>
          <strong className="signal-detail-price">{price(active.livePrice ?? active.price)}</strong><span className={`signal-change ${(active.liveChange24h ?? active.change24h) < 0 ? "negative" : "positive"}`}>{percent(active.liveChange24h ?? active.change24h)} today</span>
          <div className="signal-metrics"><Metric label="Score" value={`${active.score > 0 ? "+" : ""}${active.score}`} /><Metric label="RSI · 14" value={active.rsi.toFixed(0)} /><Metric label="Momentum" value={percent(active.change24h)} /><Metric label="Confidence" value={percent(active.confidence * 100, 0)} /></div>
          <div className="signal-context"><span className="eyebrow">Market read</span><p>{active.aiSummary ?? `${active.regime?.replaceAll("_", " ") ?? "Live bStock"} · ${active.newsArticles ?? 0} recent news items · ${active.volumeRatio?.toFixed(1) ?? "—"}× average volume`}</p><div className="signal-context-line"><span>News context</span><strong>{active.aiVerdict ?? (active.newsScore == null ? "Awaiting analysis" : `${active.newsScore > 0 ? "+" : ""}${active.newsScore.toFixed(1)}`)}</strong></div></div>
          <WorkflowDiagram
            className="signal-workflow"
            label="From market read to recorded order"
            steps={[
              { title: "Read", detail: "Price, volume, news" },
              { title: "Score", detail: "Direction + strength" },
              { title: "Check", detail: "Risk + available balance" },
              { title: "Record", detail: "Fill or skip reason" },
            ]}
            caption="A signal is a candidate. It reaches the ledger only after checks pass and an execution is confirmed."
          />
        </> : <div className="empty-state">Signal details appear when market data is available.</div>}
      </div>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }

function TradeFeature({ state, quotes }: { state: AgentState | null; quotes: LiveQuote[] }) {
  const [tab, setTab] = useState<"positions" | "fills">("positions");
  const [selected, setSelected] = useState<string | null>(null);
  const positions = state?.positions ?? [];
  const trades = state?.trades ?? [];
  const activePosition = positions.find((position) => position.symbol === selected) ?? positions[0] ?? null;
  const activeTrade = trades.find((trade) => trade.id === selected) ?? trades[0] ?? null;
  const fills = [...trades].sort((a, b) => b.timestamp - a.timestamp).slice(0, 7);
  return (
    <div className="surface-card trade-card">
      <div className="trade-top"><div><span className="eyebrow">Activity ledger</span><p>Open book and confirmed fills</p></div><div className="trade-tabs"><button className={tab === "positions" ? "active" : ""} onClick={() => setTab("positions")} type="button">Positions <span>{positions.length}</span></button><button className={tab === "fills" ? "active" : ""} onClick={() => setTab("fills")} type="button">Fills <span>{state?.totalTrades ?? 0}</span></button></div></div>
      <div className="trade-ledger">
        <div className="trade-table">
          <div className="trade-table-head"><span>Asset</span><span>{tab === "positions" ? "Amount" : "Side"}</span><span>{tab === "positions" ? "Mark" : "Price"}</span><span>{tab === "positions" ? "Unrealized" : "Realized"}</span><span>Time</span></div>
          {tab === "positions" ? positions.slice(0, 8).map((position) => <PositionTradeRow key={position.symbol} position={position} icon={quotes.find((quote) => quote.symbol === position.symbol)?.icon} active={activePosition?.symbol === position.symbol} onClick={() => setSelected(position.symbol)} />) : fills.map((trade) => <FillRow key={trade.id} trade={trade} icon={quotes.find((quote) => quote.symbol === trade.symbol)?.icon} active={activeTrade?.id === trade.id} onClick={() => setSelected(trade.id)} />)}
          {tab === "positions" && !positions.length && <div className="empty-state">Positions will appear here after the first fill.</div>}
          {tab === "fills" && !fills.length && <div className="empty-state">Confirmed fills will appear here.</div>}
        </div>
        <aside className="trade-detail">
          {tab === "positions" && activePosition ? <>
            <div className="trade-detail-mark"><TokenLogo symbol={activePosition.symbol} src={quotes.find((quote) => quote.symbol === activePosition.symbol)?.icon} large /><span><span className="eyebrow">Open position</span><strong>{activePosition.symbol}</strong></span></div>
            <strong className="trade-detail-value">{money(activePosition.amount * activePosition.currentPrice)}</strong><span className="eyebrow">Current market value</span>
            <div className="detail-lines"><Metric label="Average entry" value={price(activePosition.entryPrice)} /><Metric label="Current mark" value={price(activePosition.currentPrice)} /><Metric label="Quantity" value={quantity(activePosition.amount)} /><Metric label="Weight" value={percent(activePosition.weight, 1)} /></div>
            <div className={`detail-pnl ${activePosition.pnl < 0 ? "negative" : "positive"}`}><span>Unrealized return</span><strong>{money(activePosition.pnl)} <small>{percent(activePosition.pnlPct)}</small></strong></div>
          </> : tab === "fills" && activeTrade ? <>
            <div className="trade-detail-mark"><TokenLogo symbol={activeTrade.symbol} src={quotes.find((quote) => quote.symbol === activeTrade.symbol)?.icon} large /><span><span className="eyebrow">Confirmed fill</span><strong>{activeTrade.symbol}</strong></span></div>
            <strong className="trade-detail-value">{money(activeTrade.total)}</strong><span className="eyebrow">{activeTrade.side === "buy" ? "Buy value" : "Sell value"}</span>
            <div className="detail-lines"><Metric label="Side" value={activeTrade.side.toUpperCase()} /><Metric label="Execution price" value={price(activeTrade.price)} /><Metric label="Quantity" value={quantity(activeTrade.amount)} /><Metric label="Time" value={elapsed(activeTrade.timestamp)} /></div>
            <div className={`detail-pnl ${(activeTrade.pnl ?? 0) < 0 ? "negative" : "positive"}`}><span>Realized result</span><strong>{activeTrade.pnl == null ? "—" : money(activeTrade.pnl)}</strong></div>
          </> : <div className="empty-state">Select a row to see its details.</div>}
        </aside>
      </div>
      <div className="ledger-bottom"><span>Realized P&amp;L</span><strong className={(state?.realizedPnl ?? 0) < 0 ? "negative" : "positive"}>{money(state?.realizedPnl)}</strong><span>Closed trades</span><strong>{state?.closedTrades ?? 0}</strong></div>
    </div>
  );
}
function PositionTradeRow({ position, icon, active, onClick }: { position: Position; icon?: string; active: boolean; onClick: () => void }) {
  return <button className={`trade-row ${active ? "active" : ""}`} onClick={onClick} type="button"><span className="trade-asset"><TokenLogo symbol={position.symbol} src={icon} /><strong>{position.symbol}</strong></span><span>{quantity(position.amount)}</span><span>{price(position.currentPrice)}</span><strong className={position.pnl < 0 ? "negative" : "positive"}>{money(position.pnl)}</strong><span>Open</span></button>;
}
function FillRow({ trade, icon, active, onClick }: { trade: Trade; icon?: string; active: boolean; onClick: () => void }) {
  return <button className={`trade-row ${active ? "active" : ""}`} onClick={onClick} type="button"><span className="trade-asset"><TokenLogo symbol={trade.symbol} src={icon} /><strong>{trade.symbol}</strong></span><span className={`trade-side ${trade.side}`}>{trade.side}</span><span>{price(trade.price)}</span><strong className={(trade.pnl ?? 0) < 0 ? "negative" : "positive"}>{trade.pnl == null ? "—" : money(trade.pnl)}</strong><span>{elapsed(trade.timestamp)}</span></button>;
}

function WalletMiniChart() {
  const gradientId = `wallet-chart-${useId().replace(/:/g, "")}`;
  const line = "M8 56C30 54 41 60 62 47S98 50 120 39s32 8 54-10 33 7 54-11 39 8 64-10";
  return (
    <div className="wallet-mini-chart">
      <div className="wallet-chart-head"><div><span className="eyebrow">Account value · sample</span><strong>$2,050.84</strong></div><span>+1.4% today</span></div>
      <svg viewBox="0 0 300 76" role="img" aria-label="Illustrative sample account value chart">
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#12b264" stopOpacity=".32" /><stop offset="1" stopColor="#3b9eff" stopOpacity="0" /></linearGradient>
          <linearGradient id={`${gradientId}-line`} x1="8" x2="292" y1="50" y2="10" gradientUnits="userSpaceOnUse"><stop stopColor="#12b264" /><stop offset="1" stopColor="#3b9eff" /></linearGradient>
        </defs>
        <path className="wallet-chart-grid" d="M8 15H292M8 40H292M8 66H292" />
        <path className="wallet-chart-area" d={`${line} L292 66H8Z`} fill={`url(#${gradientId})`} />
        <path className="wallet-chart-line" d={line} stroke={`url(#${gradientId}-line)`} />
        <circle className="wallet-chart-end" cx="292" cy="8" r="3" />
      </svg>
      <div className="wallet-chart-axis"><span>MON</span><span>TUE</span><span>WED</span><span>THU</span><span>FRI</span></div>
    </div>
  );
}

function WalletFeature({ quotes }: { quotes: LiveQuote[] }) {
  const holdings = sampleWalletHoldings.map((holding) => ({ ...holding, icon: quotes.find((quote) => quote.symbol === holding.symbol)?.icon }));
  return (
    <div className="feature-grid wallet-grid">
      <div className="surface-card wallet-account">
        <div className="panel-topline"><div><span className="eyebrow">Agentic wallet</span><p>Example account overview</p></div><Wallet size={18} /></div>
        <div className="balance-cards"><div><span>Available to trade</span><strong>$825.00</strong><small>USDT</small></div><div><span>Gas reserve</span><strong>0.0800</strong><small>BNB</small></div></div>
        <WalletMiniChart />
        <div className="account-bottom"><span>Sample account</span><span>Illustrative data</span></div>
      </div>
      <div className="surface-card wallet-side">
        <div className="panel-topline"><div><span className="eyebrow">Token holdings</span><p>Example positions</p></div><span className="eyebrow">Sample view</span></div>
        <div className="holding-list">{holdings.map((holding) => <div className="holding-row" key={holding.symbol}><TokenLogo symbol={holding.symbol} src={holding.icon} /><span><strong>{holding.symbol}</strong><small>{quantity(holding.remainQty)}</small></span><span className={holding.percentChange24h < 0 ? "negative" : "positive"}>{percent(holding.percentChange24h, 1)}</span><strong>{money(holding.valueUsd)}</strong></div>)}{!holdings.length && <p className="empty-state">Token holdings will appear here.</p>}</div>
        <div className="wallet-holdings-total"><span>Example holdings value</span><strong>$1,225.84</strong></div>
      </div>
    </div>
  );
}

function FeatureChapter({ feature, index, children }: { feature: Feature; index: number; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const progress = useSpring(scrollYProgress, { stiffness: 64, damping: 32, mass: .7 });
  const scale = useTransform(progress, [0, .42, 1], [.965, 1, .985]);
  const y = useTransform(progress, [0, .5, 1], [24, 0, -18]);
  const opacity = useTransform(progress, [0, .16, .84, 1], [.56, 1, 1, .72]);
  const brainY = useTransform(progress, [0, .5, 1], [72, 0, -72]);
  const brainScale = useTransform(progress, [0, .5, 1], [.84, 1.08, .96]);
  const brainOpacity = useTransform(progress, [0, .2, .78, 1], [.12, .32, .32, .14]);
  return (
    <section className={`feature-chapter feature-${feature.id}`} id={index === 0 ? "features" : feature.id} ref={ref}>
      <motion.div className="feature-brain-layer" style={reduce ? undefined : { y: brainY, scale: brainScale, opacity: brainOpacity }} aria-hidden="true"><NeuralBackdrop /></motion.div>
      <motion.div className="feature-inner" style={reduce ? undefined : { scale, y, opacity }}>
        <motion.div className="feature-heading-reveal" initial={reduce ? false : { opacity: 0, y: 20, filter: "blur(5px)" }} whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }} viewport={{ once: true, amount: .16 }} transition={{ duration: .78, ease: [.2, .72, .22, 1] }}>
          <FeatureHeading feature={feature} />
        </motion.div>
        <motion.div className="feature-content" initial={reduce ? false : { opacity: 0, y: 24, scale: .99, filter: "blur(3px)" }} whileInView={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }} viewport={{ once: true, amount: .1 }} transition={{ duration: .82, delay: .08, ease: [.2, .72, .22, 1] }}>{children}</motion.div>
      </motion.div>
    </section>
  );
}

export function SystemExperience() {
  const { snapshot, wallet, logs } = useLiveDesk();
  const state = useMemo(() => snapshot ? enrichStateWithWallet(mapTrack1ToDashboard(snapshot, logs), wallet?.binancePositions) : null, [snapshot, logs, wallet]);
  const quotes = useQuotes(snapshot, state?.signals ?? [], wallet, state?.positions ?? []);
  const [selected, setSelected] = useState(defaultSymbols[0]);
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 90, damping: 28, restDelta: .001 });
  useEffect(() => { if (!quotes.some((quote) => quote.symbol === selected) && quotes[0]) setSelected(quotes[0].symbol); }, [quotes, selected]);
  return (
    <main className="system-page">
      <motion.div className="page-progress" style={{ scaleX: progress }} />
      <header className="system-header"><a className="system-brand" href="/" aria-label="Neural Alpha dashboard"><BrandLogo priority /></a><nav aria-label="Page navigation"><a href="#features">About</a><a href="#winner">1st place</a><a href="/" className="header-cta">Dashboard <span>↗</span></a></nav></header>
      <Hero state={state} snapshot={snapshot} quotes={quotes} selected={selected} onSelect={setSelected} />
      <WinnerShowcase />
      <FeatureChapter feature={features[0]} index={0}><PortfolioFeature state={state} snapshot={snapshot} quotes={quotes} /></FeatureChapter>
      <FeatureChapter feature={features[1]} index={1}><RiskFeature state={state} /></FeatureChapter>
      <FeatureChapter feature={features[2]} index={2}><SignalFeature state={state} quotes={quotes} /></FeatureChapter>
      <FeatureChapter feature={features[3]} index={3}><TradeFeature state={state} quotes={quotes} /></FeatureChapter>
      <FeatureChapter feature={features[4]} index={4}><WalletFeature quotes={quotes} /></FeatureChapter>
      <footer className="system-footer"><img className="footer-logo" src="/brand/neural-alpha-logo-color.svg" alt="Neural Alpha" width={2400} height={969} /><a href="/">Open the live dashboard <span>↗</span></a></footer>
    </main>
  );
}
