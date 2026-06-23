"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Radar,
  TrendingUp,
  TrendingDown,
  Newspaper,
  Sparkles,
  ChevronDown,
  Flame,
} from "lucide-react";
import { cn, formatUsd, formatPct } from "@/lib/utils";
import type { Signal } from "@/lib/mock-data";
import { isAlphaToken } from "@/lib/alpha-tokens";

const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "DAI", "USD1", "USDE", "USDD", "TUSD", "FDUSD", "USDF",
  "FRAX", "FRXUSD", "DUSD", "LISUSD", "EURI", "XUSD", "STABLE", "BUSD",
]);

/** Total competition-eligible universe (149 BEP-20), for context labelling. */
const ELIGIBLE_UNIVERSE = 149;

function SignalBadge({ strength }: { strength: Signal["strength"] }) {
  const config = {
    strong_buy: { label: "STRONG BUY", color: "text-neon bg-neon/10 border-neon/20" },
    buy: { label: "BUY", color: "text-neon/80 bg-neon/5 border-neon/10" },
    neutral: { label: "HOLD", color: "text-text-secondary bg-surface-overlay border-border-dim" },
    sell: { label: "SELL", color: "text-danger/80 bg-danger/5 border-danger/10" },
    strong_sell: { label: "STRONG SELL", color: "text-danger bg-danger/10 border-danger/20" },
  }[strength];

  return (
    <span
      className={cn(
        "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border whitespace-nowrap",
        config.color
      )}
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {config.label}
    </span>
  );
}

function ScoreRing({ score, size = 36 }: { score: number; size?: number }) {
  const rounded = Math.round(score);
  const absScore = Math.min(Math.abs(rounded), 100);
  const circumference = 2 * Math.PI * (size / 2 - 3);
  const offset = circumference - (absScore / 100) * circumference;
  const isPositive = rounded >= 0;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={size / 2 - 3}
          fill="none"
          stroke="rgba(255,255,255,0.04)"
          strokeWidth={2}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={size / 2 - 3}
          fill="none"
          stroke={isPositive ? "#0ecb81" : "#f6465d"}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        />
      </svg>
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center text-[10px] font-bold tabular-nums",
          isPositive ? "text-neon" : "text-danger"
        )}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {rounded > 0 ? "+" : ""}{rounded}
      </span>
    </div>
  );
}

function IndicatorCell({
  label,
  value,
  highlight,
  danger,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-[52px]">
      <span
        className="text-[9px] uppercase tracking-wider text-text-muted font-medium"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {label}
      </span>
      <span
        className={cn(
          "text-[12px] tabular-nums font-semibold",
          highlight ? "text-amber-400" : danger ? "text-danger" : "text-text-primary"
        )}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {value}
      </span>
    </div>
  );
}

function SignalRow({ signal, index }: { signal: Signal; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const isVolumeSpike = (signal.volumeRatio ?? 0) >= 2;
  const hasAi = !!signal.aiSummary;

  const rsiDanger = signal.rsi > 70 || signal.rsi < 30;
  const macdPositive = signal.macd >= 0;
  const newsScore = signal.newsScore;
  const hasNews = signal.newsArticles != null && signal.newsArticles > 0 && newsScore != null;

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.05 + index * 0.03 }}
      className={cn(
        "border-b border-border-dim/60 last:border-b-0",
        isVolumeSpike && "bg-amber-400/[0.03] border-l-2 border-l-amber-400/50"
      )}
    >
      <button
        type="button"
        onClick={() => hasAi && setExpanded((v) => !v)}
        className={cn(
          "w-full text-left px-3 py-2.5 transition-colors",
          hasAi ? "hover:bg-surface-overlay/40 cursor-pointer" : "cursor-default",
          index % 2 === 0 && !isVolumeSpike && "bg-surface-overlay/20"
        )}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          {/* Left: score + symbol + price */}
          <div className="flex items-center gap-3 min-w-0 sm:w-[200px] shrink-0">
            <ScoreRing score={signal.score} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span
                  className="text-[13px] font-bold text-text-primary tracking-tight"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {signal.symbol}
                </span>
                {isVolumeSpike && (
                  <Flame className="size-3 text-amber-400 shrink-0" aria-label="Volume spike" />
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className="text-[12px] text-text-secondary tabular-nums font-medium"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {formatUsd(signal.price, signal.price < 1 ? 4 : 2)}
                </span>
                <span
                  className={cn(
                    "flex items-center gap-0.5 text-[11px] tabular-nums font-medium",
                    signal.change24h >= 0 ? "text-neon" : "text-danger"
                  )}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {signal.change24h >= 0 ? (
                    <TrendingUp className="size-2.5" />
                  ) : (
                    <TrendingDown className="size-2.5" />
                  )}
                  {formatPct(signal.change24h)}
                </span>
              </div>
            </div>
          </div>

          {/* Middle: indicators */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 flex-1">
            <IndicatorCell
              label="RSI"
              value={String(Math.round(signal.rsi))}
              danger={rsiDanger}
            />
            <IndicatorCell
              label="MACD"
              value={`${signal.macd > 0 ? "+" : ""}${signal.macd.toFixed(1)}`}
              highlight={macdPositive}
              danger={!macdPositive}
            />
            <IndicatorCell
              label="Vol"
              value={
                signal.volumeRatio != null
                  ? `${signal.volumeRatio.toFixed(1)}x`
                  : "—"
              }
              highlight={isVolumeSpike}
            />
            <IndicatorCell
              label="News"
              value={
                hasNews
                  ? `${(newsScore ?? 0) > 0 ? "+" : ""}${Math.round(newsScore ?? 0)}`
                  : "—"
              }
              highlight={(newsScore ?? 0) > 15}
              danger={(newsScore ?? 0) < -15}
            />
          </div>

          {/* Right: badge + confidence */}
          <div className="flex items-center gap-3 shrink-0 sm:justify-end">
            <SignalBadge strength={signal.strength} />
            <span
              className="text-[11px] text-text-secondary tabular-nums font-medium w-9 text-right"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {Math.round(signal.confidence * 100)}%
            </span>
            {hasAi && (
              <ChevronDown
                className={cn(
                  "size-3.5 text-text-muted transition-transform",
                  expanded && "rotate-180"
                )}
              />
            )}
          </div>
        </div>
      </button>

      <AnimatePresence>
        {expanded && signal.aiSummary && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-0 ml-[48px]">
              <div className="flex items-center gap-1.5 mb-1">
                <Sparkles className="size-3 text-cyan/80" />
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider text-cyan/80"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  AI TA
                </span>
                {signal.aiVerdict && (
                  <span className="text-[9px] uppercase text-text-secondary ml-1">
                    {signal.aiVerdict}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-text-secondary leading-relaxed">
                {signal.aiSummary}
              </p>
              {signal.aiAgrees === false && (
                <span className="text-[10px] text-amber-400/90 mt-1 block">
                  AI disagrees with rule signal
                </span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

type SignalTab = "eligible" | "alpha";

export function SignalMonitor({ signals }: { signals: Signal[] }) {
  const [tab, setTab] = useState<SignalTab>("eligible");

  const sorted = [...signals].sort(
    (a, b) => Math.abs(b.score) - Math.abs(a.score)
  );

  // Section 1: full eligible universe (149) minus stablecoins.
  const eligibleSignals = sorted.filter(
    (s) => !STABLE_SYMBOLS.has(s.symbol.toUpperCase())
  );
  // Section 2: tokens also listed on Binance Alpha (intersection with the 149).
  const alphaSignals = eligibleSignals.filter((s) => isAlphaToken(s.symbol));

  const active = tab === "alpha" ? alphaSignals : eligibleSignals;

  const tabs: { id: SignalTab; label: string; count: number; hint: string }[] = [
    {
      id: "eligible",
      label: "Eligible (149)",
      count: eligibleSignals.length,
      hint: `of ${ELIGIBLE_UNIVERSE}`,
    },
    {
      id: "alpha",
      label: "Binance Alpha",
      count: alphaSignals.length,
      hint: "common w/ 149",
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.35 }}
      className="glass-raised rounded-xl p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center size-7 rounded-lg bg-neon/8">
            <Radar className="size-3.5 text-neon" />
          </div>
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Signal Monitor
          </h3>
          <span
            className="text-[11px] text-text-secondary tabular-nums font-medium"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {active.length} scanned
          </span>
        </div>
        <div
          className="flex flex-wrap items-center gap-3 text-[10px] text-text-secondary font-medium"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-neon" /> Buy
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-text-muted" /> Hold
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-danger" /> Sell
          </span>
          <span className="flex items-center gap-1">
            <Flame className="size-3 text-amber-400" /> Vol spike
          </span>
          <span className="flex items-center gap-1">
            <Newspaper className="size-3 text-cyan" /> News
          </span>
          <span className="flex items-center gap-1">
            <Sparkles className="size-3 text-cyan/80" /> AI
          </span>
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex items-center gap-1.5 mb-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all border",
              tab === t.id
                ? "bg-neon/12 text-neon border-neon/25"
                : "bg-surface-overlay/40 text-text-secondary border-border-dim hover:border-border-glow hover:text-text-primary"
            )}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {t.id === "alpha" && <Sparkles className="size-3" />}
            <span>{t.label}</span>
            <span
              className={cn(
                "tabular-nums rounded px-1.5 py-0.5 text-[10px]",
                tab === t.id ? "bg-neon/15 text-neon" : "bg-surface text-text-muted"
              )}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* List header — desktop only */}
      <div
        className="hidden sm:grid grid-cols-[200px_1fr_auto] gap-3 px-3 py-1.5 text-[9px] uppercase tracking-wider text-text-muted font-medium border-b border-border-dim/60 mb-0"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <span>Token</span>
        <span className="pl-1">Indicators</span>
        <span className="text-right pr-12">Signal</span>
      </div>

      <div className="rounded-lg overflow-hidden border border-border-dim/40">
        {active.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-text-muted" style={{ fontFamily: "var(--font-mono)" }}>
            {tab === "alpha"
              ? "No Binance Alpha tokens in the current scan window."
              : "Waiting for market data…"}
          </div>
        ) : (
          active.map((signal, i) => (
            <SignalRow key={signal.symbol} signal={signal} index={i} />
          ))
        )}
      </div>
    </motion.div>
  );
}
