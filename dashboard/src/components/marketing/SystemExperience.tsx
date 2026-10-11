"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import { Search, ShieldCheck, Wallet } from "lucide-react";
import type { Position, Signal, Trade } from "@/lib/mock-data";
import ParticleText from "./ParticleText";
import RotatingText from "./RotatingText";
import AnimatedContent from "./AnimatedContent";
import SplitText from "./SplitText";
import TrueFocus from "./TrueFocus";
import GooeyNav from "./GooeyNav";
import BorderGlow from "./BorderGlow";
import "./system.css";

type CssVarStyle = CSSProperties & Record<`--${string}`, string | number>;

function cssVars(style: CssVarStyle): CssVarStyle {
  return style;
}

const edgeGlow = {
  edgeSensitivity: 30,
  glowColor: "40 80 80",
  glowRadius: 18,
  glowIntensity: 1,
  coneSpread: 25,
  animated: true,
  colors: ["#c084fc", "#f472b6", "#38bdf8"],
};

function usePaintSharp<T extends HTMLElement>() {
  const reduce = useReducedMotion() === true;
  const ref = useRef<T>(null);
  const [sharp, setSharp] = useState(false);
  const onAnimationComplete = useCallback(() => {
    const node = ref.current;
    if (node && Number(getComputedStyle(node).opacity) < 0.99) return;
    setSharp(true);
  }, []);
  return { ref, done: reduce || sharp, onAnimationComplete };
}

const cardEntrance = {
  distance: 100,
  direction: "vertical" as const,
  reverse: false,
  duration: 0.8,
  ease: "power3.out",
  initialOpacity: 0,
  animateOpacity: true,
  scale: 1,
  threshold: 0.1,
  delay: 0,
};

type LiveQuote = { symbol: string; price: number | null; change24hPct: number | null; icon?: string };
type RangeKey = "1D" | "1W" | "1M" | "ALL";
type Feature = { id: "portfolio" | "agent" | "signals" | "ledger" | "wallet"; title: string; phrases: string[]; description: string; paired?: boolean };

const features: Feature[] = [
  { id: "portfolio", title: "Portfolio", phrases: ["NAV History", "Open Position"], paired: true, description: "Track allocation, open exposure, and NAV history together. Select a holding to focus its share of the portfolio." },
  { id: "agent", title: "Risk checks", phrases: ["before a route", "screens the book", "checks risk"], description: "See how the agent screens opportunities, checks portfolio risk, and only then considers a route." },
  { id: "signals", title: "Signals", phrases: ["for every bStock", "sample readings", "current context"], description: "Filter a fixed sample of bStock signals, compare the readings, and open a row for its context." },
  { id: "ledger", title: "Positions", phrases: ["and confirmed fills", "open exposure", "price and size"], description: "Move between open exposure and confirmed fills, then inspect the price, size, and realized result." },
  { id: "wallet", title: "Wallet", phrases: ["balances on hand", "bStock holdings", "sample account"], description: "Explore a sample wallet with available balances and bStock holdings, arranged like the dashboard." },
];
const ranges: RangeKey[] = ["1D", "1W", "1M", "ALL"];
const tokenIcons: Record<string, string> = {
  NVDAB: "https://bin.bnbstatic.com/images/web3-data/public/token/logos/9dc00cf6f4c44054b6be2d2e032b76c0.png",
  TSLAB: "https://bin.bnbstatic.com/images/web3-data/public/token/logos/3f0d2deb79c148d1be92596e3ca827d1.png",
  METAB: "https://bin.bnbstatic.com/images/web3-data/public/token/logos/71856b03dcf746f9997d05baacac06ba.png",
  MSFTB: "https://bin.bnbstatic.com/images/web3-data/public/token/logos/ba09db2c5dd94560ab772bd36d124ce9.png",
  GOOGLB: "https://bin.bnbstatic.com/images/web3-data/public/token/logos/b8817c8f4a4345f8940181efbdff3037.png",
  AAPLB: "https://bin.bnbstatic.com/images/web3-data/public/token/logos/b3a52777fff7485aa6957b5e1f262173.png",
  AMZNB: "https://bin.bnbstatic.com/images/web3-data/public/token/logos/13fc6a4099ea408ba399eb4f699dcdfa.png",
};
const overviewQuotes: LiveQuote[] = [
  { symbol: "NVDAB", price: 186.2, change24hPct: 1.42, icon: tokenIcons.NVDAB },
  { symbol: "AAPLB", price: 232.4, change24hPct: 0.41, icon: tokenIcons.AAPLB },
  { symbol: "MSFTB", price: 421.1, change24hPct: 0.82, icon: tokenIcons.MSFTB },
  { symbol: "TSLAB", price: 241.5, change24hPct: -2.61, icon: tokenIcons.TSLAB },
  { symbol: "AMZNB", price: 201.3, change24hPct: 0.64, icon: tokenIcons.AMZNB },
  { symbol: "GOOGLB", price: 178.9, change24hPct: -0.35, icon: tokenIcons.GOOGLB },
];
const overviewPositions: Position[] = [
  { symbol: "NVDAB", amount: 2.4, entryPrice: 178, currentPrice: 186.2, pnl: 19.68, pnlPct: 4.61, weight: 35.8 },
  { symbol: "AAPLB", amount: 4.1, entryPrice: 228, currentPrice: 232.4, pnl: 18.04, pnlPct: 1.93, weight: 24.1 },
  { symbol: "MSFTB", amount: 1.8, entryPrice: 415, currentPrice: 421.1, pnl: 10.98, pnlPct: 1.47, weight: 19.2 },
  { symbol: "TSLAB", amount: 1.1, entryPrice: 248, currentPrice: 241.5, pnl: -7.15, pnlPct: -2.62, weight: 12.6 },
  { symbol: "AMZNB", amount: 2.2, entryPrice: 198, currentPrice: 201.3, pnl: 7.26, pnlPct: 1.67, weight: 8.3 },
];
const overviewSignals: Signal[] = [
  { symbol: "NVDAB", action: "buy", strength: "buy", score: 28, rsi: 48, macd: 0.12, confidence: 0.72, price: 186.2, change24h: 1.42, regime: "risk_on", volumeRatio: 1.6, newsArticles: 2, newsScore: 12, aiSummary: "NVDAB is the strongest name in this sample. Price is up, and the reading is steady enough to consider.", aiVerdict: "bullish", icon: tokenIcons.NVDAB },
  { symbol: "MSFTB", action: "buy", strength: "buy", score: 16, rsi: 55, macd: 0.04, confidence: 0.61, price: 421.1, change24h: 0.82, regime: "neutral", volumeRatio: 1.1, newsArticles: 1, newsScore: 4, aiVerdict: "neutral", icon: tokenIcons.MSFTB },
  { symbol: "AAPLB", action: "hold", strength: "neutral", score: 8, rsi: 52, macd: 0.02, confidence: 0.55, price: 232.4, change24h: 0.41, regime: "neutral", volumeRatio: 0.9, newsArticles: 1, newsScore: 1, aiVerdict: "neutral", icon: tokenIcons.AAPLB },
  { symbol: "AMZNB", action: "hold", strength: "neutral", score: 5, rsi: 49, macd: 0.01, confidence: 0.51, price: 201.3, change24h: 0.64, regime: "neutral", volumeRatio: 1.0, newsArticles: 0, newsScore: 0, aiVerdict: "neutral", icon: tokenIcons.AMZNB },
  { symbol: "GOOGLB", action: "hold", strength: "neutral", score: -4, rsi: 46, macd: -0.02, confidence: 0.48, price: 178.9, change24h: -0.35, regime: "neutral", volumeRatio: 0.8, newsArticles: 1, newsScore: -2, aiVerdict: "neutral", icon: tokenIcons.GOOGLB },
  { symbol: "TSLAB", action: "sell", strength: "sell", score: -22, rsi: 71, macd: -0.08, confidence: 0.64, price: 241.5, change24h: -2.61, regime: "risk_off", volumeRatio: 1.3, newsArticles: 1, newsScore: -8, aiSummary: "TSLAB is stretched and down on the day. In this sample it is the name to reduce.", aiVerdict: "bearish", icon: tokenIcons.TSLAB },
  { symbol: "METAB", action: "sell", strength: "sell", score: -14, rsi: 63, macd: -0.05, confidence: 0.57, price: 612.4, change24h: -1.12, regime: "neutral", volumeRatio: 0.95, newsArticles: 2, newsScore: -3, aiVerdict: "caution", icon: tokenIcons.METAB },
];
const overviewTrades: Trade[] = [
  { id: "sample-msft", timestamp: Date.UTC(2026, 9, 8, 15, 10), symbol: "MSFTB", side: "buy", amount: 1.8, price: 415, total: 747, txHash: "sample", pnl: undefined },
  { id: "sample-googl", timestamp: Date.UTC(2026, 9, 6, 14, 40), symbol: "GOOGLB", side: "sell", amount: 1.4, price: 181.2, total: 253.68, txHash: "sample", pnl: 24.26 },
  { id: "sample-nvda", timestamp: Date.UTC(2026, 9, 2, 16, 5), symbol: "NVDAB", side: "buy", amount: 2.4, price: 178, total: 427.2, txHash: "sample" },
];
const overviewNav = Array.from({ length: 30 }, (_, index) => {
  const day = index + 1;
  const wave = Math.sin(index / 3.2) * 70;
  return { timestamp: Date.UTC(2026, 8, 9 + day, 16, 0), totalValueUsd: Math.round((11840 + index * 22 + wave) * 100) / 100 };
});
const overviewValue = 12480.4;
const overviewUnrealized = overviewPositions.reduce((sum, position) => sum + position.pnl, 0);
const sampleWalletHoldings = [
  { symbol: "NVDAB", remainQty: 0.8, percentChange24h: 2.4, valueUsd: 150.08, icon: tokenIcons.NVDAB },
  { symbol: "AAPLB", remainQty: 1.2, percentChange24h: 0.8, valueUsd: 399.96, icon: tokenIcons.AAPLB },
  { symbol: "MSFTB", remainQty: 0.7, percentChange24h: 1.2, valueUsd: 289.1, icon: tokenIcons.MSFTB },
  { symbol: "AMZNB", remainQty: 1.05, percentChange24h: 0.6, valueUsd: 231, icon: tokenIcons.AMZNB },
  { symbol: "TSLAB", remainQty: 0.45, percentChange24h: -0.5, valueUsd: 155.7, icon: tokenIcons.TSLAB },
];

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
function sampleDate(value: number) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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
  const tone: CssVarStyle = { "--token-tone": tokenTone(symbol) };
  return <span className={`token-mark fallback${large ? " large" : ""}`} style={tone} aria-hidden="true">{short}</span>;
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
    <div className="pulse-chart" role="group" aria-label="Sample bStock price changes">
      <div className="pulse-grid" aria-hidden="true"><span /><span /><span /></div>
      {quotes.slice(0, 6).map((quote, index) => {
        const change = quote.change24hPct ?? 0;
        const height = 34 + Math.abs(change) / max * 98;
        return (
          <button className={`pulse-column ${selected === quote.symbol ? "selected" : ""}`} type="button" key={quote.symbol} onClick={() => onSelect(quote.symbol)} aria-pressed={selected === quote.symbol}>
            <span className={`pulse-change ${change < 0 ? "down" : "up"}`}>{percent(change)}</span>
            <TokenLogo symbol={quote.symbol} src={quote.icon} />
            <span className={`pulse-bar ${change < 0 ? "down" : ""}`} style={cssVars({ "--bar-height": `${height}px`, "--bar-tone": tokenTone(quote.symbol), "--bar-order": index })} />
            <span className="pulse-symbol">{quote.symbol}</span>
          </button>
        );
      })}
      {!quotes.length && <p className="empty-state">Waiting for eligible bStock prices.</p>}
    </div>
  );
}

type GatewayPoint = { x: number; y: number };
type GatewayStream = {
  x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number;
  rgb: string;
  phase: number;
  speed: number;
  pts: GatewayPoint[];
};

function gatewayPoint(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, t: number): GatewayPoint {
  const m = 1 - t;
  return {
    x: m * m * m * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3,
    y: m * m * m * y0 + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3,
  };
}

function resampleGateway(raw: GatewayPoint[], gap: number): GatewayPoint[] {
  const out: GatewayPoint[] = [raw[0]];
  let acc = 0;
  for (let i = 1; i < raw.length; i++) {
    let x = raw[i - 1].x;
    let y = raw[i - 1].y;
    const nx = raw[i].x;
    const ny = raw[i].y;
    let dx = nx - x;
    let dy = ny - y;
    let dist = Math.hypot(dx, dy);
    if (dist === 0) continue;
    while (acc + dist >= gap) {
      const t = (gap - acc) / dist;
      x += dx * t;
      y += dy * t;
      out.push({ x, y });
      dx = nx - x;
      dy = ny - y;
      dist = Math.hypot(dx, dy);
      acc = 0;
      if (dist < 0.01) break;
    }
    acc += dist;
  }
  return out;
}

function gatewayTextFade(x: number, width: number, narrow: boolean) {
  if (narrow) return Math.min(1, Math.max(0, (x / width - 0.68) / 0.18));
  return Math.min(1, Math.max(0, (x / width - 0.4) / 0.16));
}

function GatewayFlow({ reduce }: { reduce: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const layer = canvas?.parentElement;
    if (!canvas || !layer) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const field = document.createElement("canvas");
    const fieldCtx = field.getContext("2d");
    if (!fieldCtx) return;

    let alive = true;
    let onScreen = true;
    let raf = 0;
    let originX = 78;
    let originY = 22;
    let builtW = -1;
    let builtH = -1;
    let builtNarrow = false;
    let streams: GatewayStream[] = [];
    const narrowQuery = window.matchMedia("(max-width: 560px)");
    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const still = () => reduce || reduceQuery.matches;

    const readOrigin = () => {
      const styles = getComputedStyle(layer);
      const x = parseFloat(styles.getPropertyValue("--gateway-x"));
      const y = parseFloat(styles.getPropertyValue("--gateway-y"));
      if (Number.isFinite(x)) originX = x;
      if (Number.isFinite(y)) originY = y;
    };

    const buildField = (width: number, height: number, dpr: number, narrow: boolean) => {
      const focalX = (originX / 100) * width;
      const focalY = (originY / 100) * height;
      const perSide = narrow ? 8 : 24;
      const gap = narrow ? 9 : 5.5;
      const core = narrow ? 18 : 34;
      const feather = narrow ? 56 : 108;
      const next: GatewayStream[] = [];
      field.width = Math.round(width * dpr);
      field.height = Math.round(height * dpr);
      fieldCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fieldCtx.clearRect(0, 0, width, height);

      const glow = fieldCtx.createRadialGradient(focalX, focalY, 0, focalX, focalY, narrow ? 72 : 150);
      glow.addColorStop(0, "rgba(61,220,151,0.16)");
      glow.addColorStop(0.42, "rgba(59,158,255,0.05)");
      glow.addColorStop(1, "rgba(7,8,9,0)");
      fieldCtx.fillStyle = glow;
      fieldCtx.fillRect(0, 0, width, height);

      for (const side of [-1, 1] as const) {
        for (let index = 0; index < perSide; index++) {
          const t = index / (perSide - 1);
          const y0 = height * (0.03 + t * 0.94);
          const x0 = side < 0 ? width * -0.03 : width * 1.03;
          const x1 = side < 0 ? focalX - width * 0.48 : focalX + width * 0.48;
          const y1 = y0;
          const x2 = focalX + side * (narrow ? 16 : 26);
          const y2 = focalY + (y0 - focalY) * 0.035;
          const raw: GatewayPoint[] = [];
          for (let step = 0; step <= 80; step++) raw.push(gatewayPoint(x0, y0, x1, y1, x2, y2, focalX, focalY, step / 80));
          const pts = resampleGateway(raw, gap);
          const rgb = t < 0.5
            ? (index % 2 === 0 ? "97,176,255" : "59,158,255")
            : (index % 2 === 0 ? "61,220,151" : "18,178,100");
          next.push({ x0, y0, x1, y1, x2, y2, x3: focalX, y3: focalY, rgb, phase: index * 0.073 + (side < 0 ? 0.2 : 0), speed: 0.085 + (index % 5) * 0.012, pts });

          pts.forEach((point, dot) => {
            const dist = Math.hypot(point.x - focalX, point.y - focalY);
            if (dist < core) return;
            const into = Math.min(1, (dist - core) / feather);
            const fade = gatewayTextFade(point.x, width, narrow);
            const alpha = (narrow ? 0.34 : 0.5) * into * fade * (dot % 5 === 0 ? 1 : 0.72);
            if (alpha < 0.035 || point.x < -4 || point.x > width + 4) return;
            const accent = !narrow && Math.abs(t - 0.5) < 0.06 && dot > pts.length * 0.8 && dot % 6 === 0;
            fieldCtx.fillStyle = accent ? `rgba(234,78,255,${Math.min(0.45, alpha)})` : `rgba(${rgb},${Math.min(0.8, alpha)})`;
            fieldCtx.beginPath();
            fieldCtx.arc(point.x, point.y, narrow ? 0.75 : dot % 5 === 0 ? 1.25 : 1, 0, Math.PI * 2);
            fieldCtx.fill();
          });
        }
      }
      return next;
    };

    const paint = (now: number) => {
      if (!alive) return;
      if (!onScreen || document.hidden) {
        raf = 0;
        return;
      }
      const width = layer.clientWidth;
      const height = layer.clientHeight;
      const narrow = narrowQuery.matches || width < 640;
      const dpr = 1;
      if (width > 1 && height > 1 && (width !== builtW || height !== builtH || narrow !== builtNarrow)) {
        readOrigin();
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        streams = buildField(width, height, dpr, narrow);
        builtW = width;
        builtH = height;
        builtNarrow = narrow;
      }
      if (width < 2 || height < 2) {
        if (!still()) raf = requestAnimationFrame(paint);
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(field, 0, 0, width, height);
      if (!still()) {
        const focalX = (originX / 100) * width;
        const focalY = (originY / 100) * height;
        const core = narrow ? 20 : 36;
        streams.forEach((stream) => {
          const sparks = narrow ? 1 : 2;
          for (let spark = 0; spark < sparks; spark++) {
            const u = ((now / 1000) * stream.speed + stream.phase + spark * 0.47) % 1;
            const point = gatewayPoint(stream.x0, stream.y0, stream.x1, stream.y1, stream.x2, stream.y2, stream.x3, stream.y3, u);
            const dist = Math.hypot(point.x - focalX, point.y - focalY);
            const fade = gatewayTextFade(point.x, width, narrow);
            if (dist < core || fade < 0.2 || point.x < 0 || point.x > width) continue;
            ctx.beginPath();
            ctx.fillStyle = `rgba(${stream.rgb},${narrow ? 0.16 : 0.22})`;
            ctx.arc(point.x, point.y, narrow ? 2.2 : 3.1, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.fillStyle = "rgba(244,247,248,0.92)";
            ctx.arc(point.x, point.y, narrow ? 0.9 : 1.25, 0, Math.PI * 2);
            ctx.fill();
          }
        });
        raf = requestAnimationFrame(paint);
      }
    };

    const kick = () => {
      builtW = -1;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(paint);
    };

    const resume = () => {
      if (!alive || !onScreen || document.hidden || raf) return;
      raf = requestAnimationFrame(paint);
    };
    const seen = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) resume();
    }, { rootMargin: "120px" });
    seen.observe(layer);
    document.addEventListener("visibilitychange", resume);
    paint(performance.now());
    const observer = new ResizeObserver(() => {
      if (still()) kick();
      else builtW = -1;
    });
    observer.observe(layer);
    narrowQuery.addEventListener("change", kick);
    reduceQuery.addEventListener("change", kick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      seen.disconnect();
      document.removeEventListener("visibilitychange", resume);
      narrowQuery.removeEventListener("change", kick);
      reduceQuery.removeEventListener("change", kick);
    };
  }, [reduce]);

  return <canvas ref={canvasRef} className="gateway-flow" aria-hidden="true" />;
}

function Hero({ quotes, selected, onSelect }: {
  quotes: LiveQuote[]; selected: string; onSelect: (symbol: string) => void;
}) {
  const reduce = useReducedMotion();
  const copy = usePaintSharp<HTMLDivElement>();
  const selectedQuote = quotes.find((quote) => quote.symbol === selected);
  const tone = selectedQuote?.change24hPct != null && selectedQuote.change24hPct < 0 ? "down" : "up";
  return (
    <section className="system-hero" id="top">
      <div className="hero-color-orb orb-blue" />
      <div className="hero-color-orb orb-peach" />
      <div className="hero-brain-layer" aria-hidden="true">
        <GatewayFlow reduce={reduce === true} />
        <div className="hero-brand-brain">
          <Image src="/brand/na-hero-brain.png" alt="" width={723} height={278} sizes="(max-width: 820px) 100vw, 92vw" style={{ width: "100%", height: "auto" }} />
        </div>
      </div>
      <div className="hero-layout">
        <motion.div ref={copy.ref} className={copy.done ? "hero-copy paint-sharp" : "hero-copy"} initial={copy.done ? false : { opacity: 0, y: 18 }} animate={copy.done ? { opacity: 1 } : { opacity: 1, y: 0 }} transition={{ duration: copy.done ? 0 : .65, ease: [.22, .7, .3, 1] }} onAnimationComplete={copy.onAnimationComplete}>
          <h1>
            <TrueFocus
              sentence="Trading logic you can see"
              manualMode={false}
              blurAmount={2}
              borderColor="#ea4eff"
              animationDuration={0.5}
              pauseBetweenAnimations={1}
            />
          </h1>
          <SplitText
            text="Trade bStocks with Binance Agentic Wallet while you are sleeping"
            className="hero-summary"
            delay={50}
            duration={1.25}
            ease="power3.out"
            splitType="words"
            from={{ opacity: 0, y: 40 }}
            to={{ opacity: 1, y: 0 }}
            threshold={0.1}
            rootMargin="-100px"
            textAlign="start"
            emphasis={{ text: "while you are sleeping", className: "hero-payoff" }}
          />
          <GooeyNav
            items={[
              { label: "About the desk", href: "#features" },
              { label: "Open dashboard", href: "/" },
            ]}
            particleCount={15}
            particleDistances={[90, 10]}
            particleR={100}
            initialActiveIndex={0}
            animationTime={600}
            timeVariance={300}
            colors={[1, 2, 3, 1, 2, 3, 1, 4]}
          />
        </motion.div>

        <AnimatedContent {...cardEntrance}>
          <BorderGlow {...edgeGlow} borderRadius={24}>
          <div className="market-card">
          <div className="market-card-head"><div><span className="eyebrow">Portfolio value</span><strong>{money(overviewValue, 2)}</strong></div><div className={`market-delta ${tone}`}><span>{selectedQuote?.symbol ?? selected}</span><b>{price(selectedQuote?.price)}</b><small>{percent(selectedQuote?.change24hPct)}</small></div></div>
          <TickerPulse quotes={quotes} selected={selected} onSelect={onSelect} />
          </div>
          </BorderGlow>
        </AnimatedContent>
      </div>
      <a className="scroll-cue" href="#features"><span className="scroll-line" />Scroll to explore</a>
    </section>
  );
}

const TRACK1_POST = "https://x.com/BNBChainDevs/status/2074807300632858776";

function WinnerShowcase() {
  const mountRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const copy = usePaintSharp<HTMLDivElement>();

  useEffect(() => {
    const root = mountRef.current;
    if (!root) return;
    let cancelled = false;
    let detach = () => { cancelled = true; };
    const start = () => {
      const render = () => {
        const twttr = (window as Window & { twttr?: { widgets?: { load: (el?: HTMLElement) => void } } }).twttr;
        if (!cancelled) twttr?.widgets?.load(root);
      };
      const existing = document.querySelector<HTMLScriptElement>('script[data-na-twitter="1"]');
      if ((window as Window & { twttr?: { widgets?: unknown } }).twttr?.widgets) {
        render();
        detach = () => { cancelled = true; };
        return;
      }
      const script = existing ?? document.createElement("script");
      script.addEventListener("load", render);
      if (!existing) {
        script.src = "https://platform.twitter.com/widgets.js";
        script.async = true;
        script.dataset.naTwitter = "1";
        document.body.appendChild(script);
      }
      detach = () => {
        cancelled = true;
        script.removeEventListener("load", render);
      };
    };
    const seen = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      start();
      seen.disconnect();
    }, { rootMargin: "240px" });
    seen.observe(root);
    return () => {
      detach();
      seen.disconnect();
    };
  }, []);

  return (
    <section className="winner-band" id="winner" aria-labelledby="winner-title">
      <div className="winner-inner">
        <motion.div
          ref={copy.ref}
          className={copy.done ? "winner-copy paint-sharp" : "winner-copy"}
          initial={copy.done ? false : { opacity: 0, y: 24 }}
          whileInView={copy.done ? { opacity: 1 } : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: .35 }}
          transition={{ duration: copy.done ? 0 : .72, ease: [.22, .7, .3, 1] }}
          onAnimationComplete={copy.onAnimationComplete}
        >
          <h2 id="winner-title" aria-label="BNBCHAIN Hackathon Champion">
            <ParticleText
              text="BNBCHAIN"
              particleSize={3.6}
              density={6}
              color="#EAB308"
              highlightColor="#ffed22"
              scatter={190}
              gatherDuration={1200}
              stagger={330}
              pointerRepel={42}
              repelRadius={40}
              idleDrift={0.7}
              trigger="mount"
              fontSize="clamp(3.5rem, 13vw, 9rem)"
              fontWeight={800}
              fontFamily="inherit"
            />
            <RotatingText
              texts={["Hackathon Champion", "First place"]}
              mainClassName="winner-champion px-2 md:px-3 bg-cyan-300 text-black overflow-hidden py-1 md:py-2 justify-center rounded-lg"
              staggerFrom="last"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "-120%" }}
              staggerDuration={0.025}
              splitLevelClassName="winner-rotate-split overflow-hidden pb-1"
              transition={{ type: "spring", damping: 30, stiffness: 400 }}
              rotationInterval={2000}
              splitBy="characters"
              auto={!reduce}
              loop
            />
          </h2>
          <p className="winner-summary">Neural Alpha by ClipX took first place in the autonomous trading agents track.</p>
        </motion.div>
        <AnimatedContent {...cardEntrance}>
        <BorderGlow {...edgeGlow} borderRadius={20}>
        <div className="winner-embed-wrap">
        <div className="winner-embed" ref={mountRef}>
          <blockquote className="twitter-tweet" data-theme="dark" data-dnt="true" data-conversation="none">
            <a href={TRACK1_POST}>Track 1: Autonomous Trading Agents, from BNB Chain Developers</a>
          </blockquote>
          <a className="winner-source" href={TRACK1_POST} target="_blank" rel="noreferrer">Open this post on X <span aria-hidden="true">↗</span></a>
        </div>
        </div>
        </BorderGlow>
        </AnimatedContent>
      </div>
    </section>
  );
}

const morphEase = [0.25, 0.46, 0.45, 0.94] as const;

function MorphWord({ word, reduce, onRest }: { word: string; slide?: boolean; reduce: boolean; onRest: () => void }) {
  const present = useIsPresent();
  const [resting, setResting] = useState(reduce);
  const sharp = (reduce || resting) && present;
  return (
    <motion.span
      className={sharp ? "feature-morph-word paint-sharp" : "feature-morph-word"}
      initial={reduce ? false : { y: "110%", opacity: 0 }}
      animate={sharp ? { opacity: 1 } : { y: "0%", opacity: 1 }}
      exit={reduce ? undefined : { y: "-110%", opacity: 0 }}
      transition={{ duration: sharp ? 0 : reduce ? 0 : 0.45, ease: morphEase }}
      onAnimationComplete={() => {
        if (!present) return;
        setResting(true);
        onRest();
      }}
    >
      {word}
    </motion.span>
  );
}

function MorphingLine({ words, delay = 0, slide = false }: { words: string[]; delay?: number; slide?: boolean }) {
  const reduce = useReducedMotion() === true;
  const [index, setIndex] = useState(0);
  const [restWord, setRestWord] = useState<string | null>(reduce ? words[0] ?? null : null);

  useEffect(() => {
    if (reduce || words.length < 2) return;
    let timer = window.setTimeout(function tick() {
      setIndex((prev) => (prev + 1) % words.length);
      timer = window.setTimeout(tick, 3200);
    }, 2800 + delay);
    return () => window.clearTimeout(timer);
  }, [reduce, words, delay]);

  const word = words[reduce ? 0 : index] ?? words[0];
  const lineResting = reduce || restWord === word;
  return (
    <span className="feature-morph" aria-hidden="true" style={!lineResting && !slide ? { perspective: "900px" } : undefined}>
      <AnimatePresence mode={slide ? "sync" : "wait"} initial={false}>
        <MorphWord key={word} word={word} slide={slide} reduce={reduce} onRest={() => setRestWord(word)} />
      </AnimatePresence>
    </span>
  );
}

function FeatureHeading({ feature, index }: { feature: Feature; index: number }) {
  const title = usePaintSharp<HTMLSpanElement>();
  const description = usePaintSharp<HTMLParagraphElement>();
  const titleDone = Boolean(feature.paired) || title.done;
  return (
    <div className="feature-heading">
      <div>
        <h2 className={feature.paired ? "feature-pair" : undefined} aria-label={feature.paired ? `${feature.title}: ${feature.phrases.join(", ")}` : `${feature.title} ${feature.phrases[0]}`}>
          <motion.span
            ref={title.ref}
            className={titleDone ? "feature-title-line paint-sharp" : "feature-title-line"}
            initial={titleDone ? false : { opacity: 0, y: 12 }}
            whileInView={titleDone ? { opacity: 1 } : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: titleDone ? 0 : 0.45, ease: morphEase }}
            onAnimationComplete={title.onAnimationComplete}
          >
            {feature.title}
          </motion.span>
          <MorphingLine words={feature.phrases} delay={index * 280} slide={feature.paired} />
        </h2>
      </div>
      <motion.p
        ref={description.ref}
        className={description.done ? "feature-description paint-sharp" : "feature-description"}
        initial={description.done ? false : { opacity: 0, y: 10 }}
        whileInView={description.done ? { opacity: 1 } : { opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.7 }}
        transition={{ duration: description.done ? 0 : 0.55, delay: description.done ? 0 : 0.16, ease: morphEase }}
        onAnimationComplete={description.onAnimationComplete}
      >
        {feature.description}
      </motion.p>
    </div>
  );
}

function toChartPoints(points: { timestamp: number; totalValueUsd: number }[], range: RangeKey) {
  if (range === "ALL") return points;
  const count = range === "1D" ? 2 : range === "1W" ? 7 : points.length;
  return points.slice(-count);
}
function makeChartPath(values: number[]) {
  if (values.length < 2) return null;
  const min = Math.min(...values); const max = Math.max(...values); const span = max - min || Math.max(max * .01, 1);
  const coords = values.map((value, index) => ({ x: 24 + (index / (values.length - 1)) * 952, y: 218 - ((value - min) / span) * 184 }));
  return { coords, line: coords.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ") };
}

function InteractiveAreaChart({ range, onRange }: { range: RangeKey; onRange: (range: RangeKey) => void }) {
  const [active, setActive] = useState<number | null>(null);
  const gradientId = `portfolio-fill-${useId().replace(/:/g, "")}`;
  const points = useMemo(() => toChartPoints(overviewNav, range), [range]);
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
      <div className="area-toolbar"><div><span className="eyebrow">Net asset value</span><strong>{money(points.at(-1)?.totalValueUsd ?? overviewValue, 2)}</strong></div><div className="range-select" aria-label="Chart time range">{ranges.map((item) => <button key={item} className={range === item ? "active" : ""} onClick={() => onRange(item)} type="button">{item}</button>)}</div></div>
      <div className="area-canvas">
        {path ? <>
          <svg viewBox="0 0 1000 250" preserveAspectRatio="none" onPointerMove={handleMove} onPointerLeave={() => setActive(null)} role="img" aria-label="Interactive portfolio value history">
            <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#45c6a4" stopOpacity=".34" /><stop offset=".68" stopColor="#81cbd8" stopOpacity=".12" /><stop offset="1" stopColor="#d9eafa" stopOpacity=".015" /></linearGradient></defs>
            <path className="area-grid" d="M24 36H976M24 104H976M24 172H976M24 230H976" />
            <path className="area-fill" d={`${path.line} L976 230 L24 230 Z`} fill={`url(#${gradientId})`} />
            <path className="area-line" d={path.line} />
            {activePoint && <><path className="area-crosshair" d={`M${activePoint.x} 28V230`} /><circle className="area-active-dot" cx={activePoint.x} cy={activePoint.y} r="5" /></>}
          </svg>
          {active != null && points[active] && <div className="chart-tooltip" style={{ left: `${Math.min(88, Math.max(4, (active / Math.max(1, points.length - 1)) * 92))}%` }}><span>{sampleDate(points[active].timestamp)}</span><b>{money(points[active].totalValueUsd)}</b></div>}
          <div className="chart-axis"><span>{points[0] ? sampleDate(points[0].timestamp) : ""}</span><span>{points.at(-1) ? sampleDate(points.at(-1)!.timestamp) : ""}</span></div>
        </> : <div className="chart-empty"><span>No NAV history yet</span><p>Portfolio history appears here as the agent records account snapshots.</p></div>}
      </div>
    </div>
  );
}

function PortfolioFeature() {
  const [range, setRange] = useState<RangeKey>("1M");
  const [focus, setFocus] = useState<string | null>(null);
  const positions = overviewPositions;
  const sorted = [...positions].sort((a, b) => b.weight - a.weight);
  const focusPosition = sorted.find((position) => position.symbol === focus);
  return (
    <div className="feature-grid portfolio-grid">
      <AnimatedContent {...cardEntrance}>
      <BorderGlow {...edgeGlow} borderRadius={24}>
      <div className="surface-card portfolio-main">
        <div className="panel-topline"><div><span className="eyebrow">Portfolio performance</span><p>Value over time</p></div><span className="subtle-value">{positions.length} holdings</span></div>
        <InteractiveAreaChart range={range} onRange={setRange} />
        <div className="allocation-foot"><span>Allocation focus</span><strong>{focusPosition?.symbol ?? "All holdings"}</strong><span>{focusPosition ? percent(focusPosition.weight, 1) : "Select a holding"}</span></div>
      </div>
      </BorderGlow>
      </AnimatedContent>
      <AnimatedContent {...cardEntrance} delay={0.12}>
      <BorderGlow {...edgeGlow} borderRadius={24}>
      <div className="surface-card positions-card">
        <div className="panel-topline"><div><span className="eyebrow">Open positions</span><p>Current exposure</p></div><strong className="position-count">{positions.length.toString().padStart(2, "0")}</strong></div>
        <div className="position-list">
          {sorted.slice(0, 6).map((position) => {
            return <button className={`position-item ${focus === position.symbol ? "active" : ""}`} key={position.symbol} onClick={() => setFocus(focus === position.symbol ? null : position.symbol)} type="button">
              <TokenLogo symbol={position.symbol} src={tokenIcons[position.symbol]} />
              <span className="position-name"><strong>{position.symbol}</strong><small>{quantity(position.amount)} shares</small></span>
              <span className="position-meter"><i style={cssVars({ "--weight": `${Math.max(5, Math.min(position.weight, 100))}%`, "--tone": tokenTone(position.symbol) })} /><small>{percent(position.weight, 1)} of book</small></span>
              <span className={`position-pnl ${position.pnl < 0 ? "negative" : "positive"}`}>{money(position.pnl)}<small>{percent(position.pnlPct)}</small></span>
            </button>;
          })}
          {!positions.length && <p className="empty-state">Open positions will appear here.</p>}
        </div>
        <div className="positions-total"><span>Unrealized P&amp;L</span><strong className={overviewUnrealized < 0 ? "negative" : "positive"}>{money(overviewUnrealized)}</strong></div>
      </div>
      </BorderGlow>
      </AnimatedContent>
    </div>
  );
}

function RiskFeature() {
  const [view, setView] = useState<"cycle" | "guide">("cycle");
  const steps = ["Read the market", "Rank candidates", "Check risk", "Route the order"];
  const stepIndex = 2;
  return (
    <div className="feature-grid risk-grid">
      <BorderGlow {...edgeGlow} borderRadius={24}>
      <div className="surface-card cycle-card">
        <div className="panel-topline"><div><span className="eyebrow">Decision cycle</span><p>From scan to execution</p></div><span className="agent-state running"><i />Sample</span></div>
        <div className="cycle-track">
          {steps.map((step, index) => <div className={`cycle-step ${stepIndex === index ? "current" : ""} ${stepIndex > index ? "done" : ""}`} key={step}>
            <span className="cycle-step-number">{String(index + 1).padStart(2, "0")}</span><span className="cycle-step-dot" /><strong>{step}</strong>{index < steps.length - 1 && <i className="cycle-connector" />}
          </div>)}
        </div>
        <div className="cycle-controls"><button type="button" className={view === "cycle" ? "active" : ""} onClick={() => setView("cycle")}>Decision flow</button><button type="button" className={view === "guide" ? "active" : ""} onClick={() => setView("guide")}>Risk guide</button></div>
      </div>
      </BorderGlow>
      <BorderGlow {...edgeGlow} borderRadius={24}>
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
      </BorderGlow>
    </div>
  );
}
function RiskPrinciple({ number, title, detail }: { number: string; title: string; detail: string }) {
  return <div className="risk-principle"><span>{number}</span><div><strong>{title}</strong><small>{detail}</small></div><i aria-hidden="true" /></div>;
}
function Guardrail({ number, title, detail }: { number: string; title: string; detail: string }) {
  return <div className="guardrail-row"><span>{number}</span><div><strong>{title}</strong><small>{detail}</small></div><i aria-hidden="true" /></div>;
}

function SignalFeature() {
  const [filter, setFilter] = useState<"all" | "buy" | "hold" | "sell">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const signals = overviewSignals;
  const filtered = useMemo(() => signals.filter((signal) => (filter === "all" || signal.action === filter) && signal.symbol.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 8), [signals, filter, search]);
  const active = filtered.find((signal) => signal.symbol === selected) ?? filtered[0] ?? signals.find((signal) => signal.symbol === selected) ?? null;
  return (
    <div className="feature-grid signal-grid">
      <AnimatedContent {...cardEntrance}>
      <BorderGlow {...edgeGlow} borderRadius={24}>
      <div className="surface-card signal-browser">
        <div className="signal-tools"><div className="signal-filters">{(["all", "buy", "hold", "sell"] as const).map((item) => <button type="button" key={item} onClick={() => setFilter(item)} className={filter === item ? "active" : ""}>{item === "all" ? "All signals" : `${item[0].toUpperCase()}${item.slice(1)}s`}<span>{item === "all" ? signals.length : signals.filter((signal) => signal.action === item).length}</span></button>)}</div><label className="signal-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a ticker" aria-label="Find a ticker" /></label></div>
        <div className="signal-list">
          {filtered.map((signal) => {
            return <button className={`signal-row ${active?.symbol === signal.symbol ? "selected" : ""}`} key={signal.symbol} onClick={() => setSelected(signal.symbol)} type="button">
              <TokenLogo symbol={signal.symbol} src={signal.icon} />
              <span className="signal-symbol"><strong>{signal.symbol}</strong><small>{signal.regime?.replaceAll("_", " ") ?? "bStock"}</small></span>
              <span className="signal-price"><strong>{price(signal.livePrice ?? signal.price)}</strong><small className={(signal.liveChange24h ?? signal.change24h) < 0 ? "negative" : "positive"}>{percent(signal.liveChange24h ?? signal.change24h)}</small></span>
              <span className="signal-score"><i><b style={{ width: `${Math.min(100, Math.abs(signal.score))}%` }} /></i><strong>{signal.score > 0 ? "+" : ""}{signal.score}</strong></span>
              <span className={`signal-action ${signal.action}`}>{signal.action}</span>
              <span className="row-arrow">↗</span>
            </button>;
          })}
          {!filtered.length && <div className="empty-state">No signals match this view.</div>}
        </div>
        <div className="signal-list-foot"><span>Sample overview</span><span>Fixed figures</span></div>
      </div>
      </BorderGlow>
      </AnimatedContent>
      <AnimatedContent {...cardEntrance} delay={0.12}>
      <BorderGlow {...edgeGlow} borderRadius={24}>
      <div className="surface-card signal-detail">
        {active ? <>
          <div className="signal-detail-title"><TokenLogo symbol={active.symbol} src={active.icon} large /><div><span className="eyebrow">Selected bStock</span><h3>{active.symbol}</h3></div><span className={`signal-action ${active.action}`}>{active.action}</span></div>
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
      </BorderGlow>
      </AnimatedContent>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }

function TradeFeature() {
  const [tab, setTab] = useState<"positions" | "fills">("positions");
  const [selected, setSelected] = useState<string | null>(null);
  const positions = overviewPositions;
  const trades = overviewTrades;
  const activePosition = positions.find((position) => position.symbol === selected) ?? positions[0] ?? null;
  const activeTrade = trades.find((trade) => trade.id === selected) ?? trades[0] ?? null;
  const fills = [...trades].sort((a, b) => b.timestamp - a.timestamp).slice(0, 7);
  return (
    <div className="surface-card trade-card">
      <div className="trade-top"><div><span className="eyebrow">Activity ledger</span><p>Open book and confirmed fills</p></div><div className="trade-tabs"><button className={tab === "positions" ? "active" : ""} onClick={() => setTab("positions")} type="button">Positions <span>{positions.length}</span></button><button className={tab === "fills" ? "active" : ""} onClick={() => setTab("fills")} type="button">Fills <span>{trades.length}</span></button></div></div>
      <div className="trade-ledger">
        <div className="trade-table">
          <div className="trade-table-head"><span>Asset</span><span>{tab === "positions" ? "Amount" : "Side"}</span><span>{tab === "positions" ? "Mark" : "Price"}</span><span>{tab === "positions" ? "Unrealized" : "Realized"}</span><span>Time</span></div>
          {tab === "positions" ? positions.slice(0, 8).map((position) => <PositionTradeRow key={position.symbol} position={position} icon={tokenIcons[position.symbol]} active={activePosition?.symbol === position.symbol} onClick={() => setSelected(position.symbol)} />) : fills.map((trade) => <FillRow key={trade.id} trade={trade} icon={tokenIcons[trade.symbol]} active={activeTrade?.id === trade.id} onClick={() => setSelected(trade.id)} />)}
          {tab === "positions" && !positions.length && <div className="empty-state">Positions will appear here after the first fill.</div>}
          {tab === "fills" && !fills.length && <div className="empty-state">Confirmed fills will appear here.</div>}
        </div>
        <aside className="trade-detail">
          {tab === "positions" && activePosition ? <>
            <div className="trade-detail-mark"><TokenLogo symbol={activePosition.symbol} src={tokenIcons[activePosition.symbol]} large /><span><span className="eyebrow">Open position</span><strong>{activePosition.symbol}</strong></span></div>
            <strong className="trade-detail-value">{money(activePosition.amount * activePosition.currentPrice)}</strong><span className="eyebrow">Current market value</span>
            <div className="detail-lines"><Metric label="Average entry" value={price(activePosition.entryPrice)} /><Metric label="Current mark" value={price(activePosition.currentPrice)} /><Metric label="Quantity" value={quantity(activePosition.amount)} /><Metric label="Weight" value={percent(activePosition.weight, 1)} /></div>
            <div className={`detail-pnl ${activePosition.pnl < 0 ? "negative" : "positive"}`}><span>Unrealized return</span><strong>{money(activePosition.pnl)} <small>{percent(activePosition.pnlPct)}</small></strong></div>
          </> : tab === "fills" && activeTrade ? <>
            <div className="trade-detail-mark"><TokenLogo symbol={activeTrade.symbol} src={tokenIcons[activeTrade.symbol]} large /><span><span className="eyebrow">Confirmed fill</span><strong>{activeTrade.symbol}</strong></span></div>
            <strong className="trade-detail-value">{money(activeTrade.total)}</strong><span className="eyebrow">{activeTrade.side === "buy" ? "Buy value" : "Sell value"}</span>
            <div className="detail-lines"><Metric label="Side" value={activeTrade.side.toUpperCase()} /><Metric label="Execution price" value={price(activeTrade.price)} /><Metric label="Quantity" value={quantity(activeTrade.amount)} /><Metric label="Time" value={sampleDate(activeTrade.timestamp)} /></div>
            <div className={`detail-pnl ${(activeTrade.pnl ?? 0) < 0 ? "negative" : "positive"}`}><span>Realized result</span><strong>{activeTrade.pnl == null ? "—" : money(activeTrade.pnl)}</strong></div>
          </> : <div className="empty-state">Select a row to see its details.</div>}
        </aside>
      </div>
      <div className="ledger-bottom"><span>Realized P&amp;L</span><strong className="positive">{money(24.26)}</strong><span>Closed trades</span><strong>1</strong></div>
    </div>
  );
}
function PositionTradeRow({ position, icon, active, onClick }: { position: Position; icon?: string; active: boolean; onClick: () => void }) {
  return <button className={`trade-row ${active ? "active" : ""}`} onClick={onClick} type="button"><span className="trade-asset"><TokenLogo symbol={position.symbol} src={icon} /><strong>{position.symbol}</strong></span><span>{quantity(position.amount)}</span><span>{price(position.currentPrice)}</span><strong className={position.pnl < 0 ? "negative" : "positive"}>{money(position.pnl)}</strong><span>Open</span></button>;
}
function FillRow({ trade, icon, active, onClick }: { trade: Trade; icon?: string; active: boolean; onClick: () => void }) {
  return <button className={`trade-row ${active ? "active" : ""}`} onClick={onClick} type="button"><span className="trade-asset"><TokenLogo symbol={trade.symbol} src={icon} /><strong>{trade.symbol}</strong></span><span className={`trade-side ${trade.side}`}>{trade.side}</span><span>{price(trade.price)}</span><strong className={(trade.pnl ?? 0) < 0 ? "negative" : "positive"}>{trade.pnl == null ? "—" : money(trade.pnl)}</strong><span>{sampleDate(trade.timestamp)}</span></button>;
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

function WalletFeature() {
  const holdings = sampleWalletHoldings;
  return (
    <AnimatedContent {...cardEntrance}>
    <div className="feature-grid wallet-grid">
      <BorderGlow {...edgeGlow} borderRadius={24}>
      <div className="surface-card wallet-account">
        <div className="panel-topline"><div><span className="eyebrow">Agentic wallet</span><p>Example account overview</p></div><Wallet size={18} /></div>
        <div className="balance-cards"><div><span>Available to trade</span><strong>$825.00</strong><small>USDT</small></div><div><span>Gas reserve</span><strong>0.0800</strong><small>BNB</small></div></div>
        <WalletMiniChart />
        <div className="account-bottom"><span>Sample account</span><span>Illustrative data</span></div>
      </div>
      </BorderGlow>
      <BorderGlow {...edgeGlow} borderRadius={24}>
      <div className="surface-card wallet-side">
        <div className="panel-topline"><div><span className="eyebrow">Token holdings</span><p>Example positions</p></div><span className="eyebrow">Sample view</span></div>
        <div className="holding-list">{holdings.map((holding) => <div className="holding-row" key={holding.symbol}><TokenLogo symbol={holding.symbol} src={holding.icon} /><span><strong>{holding.symbol}</strong><small>{quantity(holding.remainQty)}</small></span><span className={holding.percentChange24h < 0 ? "negative" : "positive"}>{percent(holding.percentChange24h, 1)}</span><strong>{money(holding.valueUsd)}</strong></div>)}{!holdings.length && <p className="empty-state">Token holdings will appear here.</p>}</div>
        <div className="wallet-holdings-total"><span>Example holdings value</span><strong>$1,225.84</strong></div>
      </div>
      </BorderGlow>
    </div>
    </AnimatedContent>
  );
}

function FeatureChapter({ feature, index, children }: { feature: Feature; index: number; children: React.ReactNode }) {
  const head = usePaintSharp<HTMLDivElement>();
  const content = usePaintSharp<HTMLDivElement>();
  return (
    <section className={`feature-chapter feature-${feature.id}`} id={index === 0 ? "features" : feature.id}>
      <div className="feature-brain-layer" aria-hidden="true"><NeuralBackdrop /></div>
      <div className="feature-inner">
        <motion.div ref={head.ref} className={head.done ? "feature-heading-reveal paint-sharp" : "feature-heading-reveal"} initial={head.done ? false : { opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true, amount: .16 }} transition={{ duration: head.done ? 0 : .35, ease: [.2, .72, .22, 1] }} onAnimationComplete={head.onAnimationComplete}>
          <FeatureHeading feature={feature} index={index} />
        </motion.div>
        {feature.id === "ledger" ? (
          <AnimatedContent {...cardEntrance}>
            <BorderGlow {...edgeGlow} borderRadius={24}>
              <div className="feature-content">{children}</div>
            </BorderGlow>
          </AnimatedContent>
        ) : (
          <motion.div ref={content.ref} className={content.done ? "feature-content paint-sharp" : "feature-content"} initial={content.done ? false : { opacity: 0, y: 24 }} whileInView={content.done ? { opacity: 1 } : { opacity: 1, y: 0 }} viewport={{ once: true, amount: .1 }} transition={{ duration: content.done ? 0 : .82, delay: content.done ? 0 : .08, ease: [.2, .72, .22, 1] }} onAnimationComplete={content.onAnimationComplete}>{children}</motion.div>
        )}
      </div>
    </section>
  );
}

export function SystemExperience() {
  const [selected, setSelected] = useState(overviewQuotes[0].symbol);
  return (
    <main className="system-page">
      <div className="page-progress" />
      <header className="system-header">
        <a className="system-brand" href="/" aria-label="Neural Alpha home"><BrandLogo priority /></a>
        <GooeyNav
          ariaLabel="Page navigation"
          items={[
            { label: "Home", href: "/" },
            { label: "Dashboard", href: "/" },
          ]}
          particleCount={15}
          particleDistances={[90, 10]}
          particleR={100}
          initialActiveIndex={0}
          animationTime={600}
          timeVariance={300}
          colors={[1, 2, 3, 1, 2, 3, 1, 4]}
        />
      </header>
      <Hero quotes={overviewQuotes} selected={selected} onSelect={setSelected} />
      <WinnerShowcase />
      <FeatureChapter feature={features[0]} index={0}><PortfolioFeature /></FeatureChapter>
      <FeatureChapter feature={features[1]} index={1}><RiskFeature /></FeatureChapter>
      <FeatureChapter feature={features[2]} index={2}><SignalFeature /></FeatureChapter>
      <FeatureChapter feature={features[3]} index={3}><TradeFeature /></FeatureChapter>
      <FeatureChapter feature={features[4]} index={4}><WalletFeature /></FeatureChapter>
      <footer className="system-footer"><img className="footer-logo" src="/brand/neural-alpha-logo-color.svg" alt="Neural Alpha" width={2400} height={969} /><a href="/">Open the live dashboard <span>↗</span></a></footer>
    </main>
  );
}
