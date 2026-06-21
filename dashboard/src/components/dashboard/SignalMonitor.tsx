"use client";

import { motion } from "framer-motion";
import {
  Radar,
  TrendingUp,
  TrendingDown,
  Newspaper,
} from "lucide-react";
import { cn, formatUsd, formatPct } from "@/lib/utils";
import type { Signal } from "@/lib/mock-data";

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
        "text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded border",
        config.color
      )}
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {config.label}
    </span>
  );
}

function RsiBar({ value }: { value: number }) {
  const rounded = Math.round(value);
  const clamped = Math.max(0, Math.min(100, rounded));
  const isOversold = clamped < 30;
  const isOverbought = clamped > 70;

  return (
    <div className="flex items-center gap-2.5 mt-2.5">
      <span
        className="text-[11px] text-text-secondary w-7 shrink-0 font-medium"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        RSI
      </span>
      <div className="relative flex-1 h-[6px] rounded-full bg-surface-overlay">
        <motion.div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            isOversold ? "bg-neon" : isOverbought ? "bg-danger" : "bg-cyan/50"
          )}
          initial={{ width: 0 }}
          animate={{ width: `${clamped}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
        <div
          className="absolute top-[-3px] bottom-[-3px] w-px bg-text-muted/30"
          style={{ left: "30%" }}
        />
        <div
          className="absolute top-[-3px] bottom-[-3px] w-px bg-text-muted/30"
          style={{ left: "70%" }}
        />
      </div>
      <span
        className={cn(
          "text-[12px] tabular-nums w-7 text-right shrink-0 font-semibold",
          isOversold ? "text-neon" : isOverbought ? "text-danger" : "text-text-primary"
        )}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {clamped}
      </span>
    </div>
  );
}

function NewsBar({
  score,
  articles,
}: {
  score: number | null | undefined;
  articles?: number;
}) {
  const hasNews = articles != null && articles > 0 && score != null;
  const clamped = hasNews ? Math.max(-100, Math.min(100, Math.round(score))) : 0;
  const isBullish = clamped > 15;
  const isBearish = clamped < -15;
  const barWidth = hasNews ? Math.min(Math.abs(clamped), 100) : 0;

  return (
    <div className="flex items-center gap-2.5">
      <span
        className="text-[11px] text-text-secondary w-7 shrink-0 font-medium"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        NWS
      </span>
      <div className="relative flex-1 h-[6px] rounded-full bg-surface-overlay overflow-hidden">
        {hasNews && (
          <motion.div
            className={cn(
              "absolute inset-y-0 rounded-full",
              isBullish ? "bg-neon left-1/2" : isBearish ? "bg-danger right-1/2" : "bg-cyan/40 left-1/2"
            )}
            style={{
              width: `${barWidth / 2}%`,
              ...(isBearish ? { right: "50%", left: "auto" } : {}),
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
          />
        )}
      </div>
      <span
        className={cn(
          "text-[12px] tabular-nums w-10 text-right shrink-0 font-semibold",
          !hasNews
            ? "text-text-muted"
            : isBullish
              ? "text-neon"
              : isBearish
                ? "text-danger"
                : "text-text-secondary"
        )}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {hasNews ? `${clamped > 0 ? "+" : ""}${clamped}` : "—"}
      </span>
    </div>
  );
}

function MacdDot({ value }: { value: number }) {
  const rounded = Math.round(value * 10) / 10;
  const isPositive = rounded >= 0;

  return (
    <div className="flex items-center gap-2.5">
      <span
        className="text-[11px] text-text-secondary w-7 shrink-0 font-medium"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        MCD
      </span>
      <div className="flex-1 flex items-center gap-1">
        {Array.from({ length: 7 }).map((_, i) => {
          const step = i - 3;
          const active =
            (isPositive && step >= 0 && step <= Math.min(Math.abs(rounded), 3)) ||
            (!isPositive && step <= 0 && step >= -Math.min(Math.abs(rounded), 3));
          return (
            <div
              key={i}
              className={cn(
                "h-[6px] flex-1 rounded-sm transition-colors",
                active
                  ? isPositive
                    ? "bg-neon/70"
                    : "bg-danger/70"
                  : "bg-surface-overlay"
              )}
            />
          );
        })}
      </div>
      <span
        className={cn(
          "text-[12px] tabular-nums w-8 text-right shrink-0 font-semibold",
          isPositive ? "text-neon/80" : "text-danger/80"
        )}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {rounded > 0 ? "+" : ""}{rounded}
      </span>
    </div>
  );
}

function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
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
          strokeWidth={2.5}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={size / 2 - 3}
          fill="none"
          stroke={isPositive ? "#0ecb81" : "#f6465d"}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        />
      </svg>
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center text-[11px] font-bold tabular-nums",
          isPositive ? "text-neon" : "text-danger"
        )}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {rounded > 0 ? "+" : ""}{rounded}
      </span>
    </div>
  );
}

function SignalCard({ signal, index }: { signal: Signal; index: number }) {
  const borderAccent =
    signal.strength === "strong_buy"
      ? "hover:border-neon/25 border-neon/8"
      : signal.strength === "strong_sell"
        ? "hover:border-danger/25 border-danger/8"
        : signal.strength === "buy"
          ? "hover:border-neon/20"
          : signal.strength === "sell"
            ? "hover:border-danger/20"
            : "hover:border-border-glow";

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 0.4 + index * 0.05 }}
      whileHover={{ y: -3, transition: { duration: 0.15 } }}
      className={cn(
        "glass-raised rounded-xl p-3.5 transition-all duration-200 cursor-default",
        borderAccent
      )}
    >
      {/* Header: Symbol + Price | Score Ring */}
      <div className="flex items-start justify-between mb-1">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span
              className="text-[14px] font-bold text-text-primary tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {signal.symbol}
            </span>
            <span
              className={cn(
                "flex items-center gap-0.5 text-[12px] tabular-nums font-medium",
                signal.change24h >= 0 ? "text-neon" : "text-danger"
              )}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {signal.change24h >= 0 ? (
                <TrendingUp className="size-3" />
              ) : (
                <TrendingDown className="size-3" />
              )}
              {formatPct(signal.change24h)}
            </span>
          </div>
          <span
            className="text-[13px] text-text-secondary tabular-nums font-medium"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {formatUsd(signal.price, signal.price < 1 ? 4 : 2)}
          </span>
        </div>
        <ScoreRing score={signal.score} />
      </div>

      {/* Indicators */}
      <div className="flex flex-col gap-1.5 mt-2 mb-3">
        <RsiBar value={signal.rsi} />
        <MacdDot value={signal.macd} />
        <NewsBar score={signal.newsScore} articles={signal.newsArticles} />
      </div>

      {/* Footer: Badge + Confidence */}
      <div className="flex items-center justify-between pt-2.5 border-t border-border-dim">
        <SignalBadge strength={signal.strength} />
        <div className="flex items-center gap-1.5">
          <div className="flex gap-px">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "w-[3px] rounded-sm",
                  i < Math.round(signal.confidence * 5)
                    ? "bg-cyan/60 h-[8px]"
                    : "bg-surface-overlay h-[6px]"
                )}
                style={{ marginTop: i < Math.round(signal.confidence * 5) ? 0 : 2 }}
              />
            ))}
          </div>
          <span
            className="text-[11px] text-text-secondary tabular-nums font-medium"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {Math.round(signal.confidence * 100)}%
          </span>
        </div>
      </div>
    </motion.div>
  );
}

export function SignalMonitor({ signals }: { signals: Signal[] }) {
  const sorted = [...signals].sort(
    (a, b) => Math.abs(b.score) - Math.abs(a.score)
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.35 }}
      className="glass-raised rounded-xl p-5"
    >
      <div className="flex items-center justify-between mb-4">
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
            {sorted.length} tokens
          </span>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-text-secondary font-medium"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-neon" /> Buy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-text-muted" /> Hold
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-danger" /> Sell
          </span>
          <span className="flex items-center gap-1.5">
            <Newspaper className="size-3 text-cyan" /> News
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {sorted.map((signal, i) => (
          <SignalCard key={signal.symbol} signal={signal} index={i} />
        ))}
      </div>
    </motion.div>
  );
}
