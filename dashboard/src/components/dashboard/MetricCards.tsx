"use client";

import { motion } from "framer-motion";
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  BarChart3,
  ArrowUpRight,
  ArrowDownRight,
  Repeat,
  Target,
} from "lucide-react";
import { cn, formatUsd, formatPct } from "@/lib/utils";
import type { AgentState } from "@/lib/mock-data";
import { BorderGlow } from "@/components/ui/BorderGlow";

type Tone = "up" | "down" | "cyan" | "muted";

interface StatProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  tone?: Tone;
  delay?: number;
}

const TONE = {
  up: {
    value: "text-neon",
    sub: "text-neon/70",
    chip: "bg-neon/10 text-neon",
    bar: "bg-neon",
    glowColor: "154 82 58",
    colors: ["#0ecb81", "#34d399", "#1e9ff2"],
  },
  down: {
    value: "text-danger",
    sub: "text-danger/70",
    chip: "bg-danger/10 text-danger",
    bar: "bg-danger",
    glowColor: "351 91 62",
    colors: ["#f6465d", "#fb7185", "#f0b90b"],
  },
  cyan: {
    value: "text-text-primary",
    sub: "text-text-muted",
    chip: "bg-cyan/10 text-cyan",
    bar: "bg-cyan",
    glowColor: "203 89 53",
    colors: ["#1e9ff2", "#38bdf8", "#0ecb81"],
  },
  muted: {
    value: "text-text-primary",
    sub: "text-text-muted",
    chip: "bg-surface-overlay text-text-muted",
    bar: "bg-border-glow",
    glowColor: "210 12 55",
    colors: ["#848e9c", "#1e9ff2", "#2b3139"],
  },
} as const;

function Stat({ label, value, sub, icon, tone = "muted", delay = 0 }: StatProps) {
  const t = TONE[tone];

  return (
    <BorderGlow
      className="min-w-[160px] flex-1"
      borderRadius={8}
      glowRadius={6}
      glowIntensity={0.7}
      coneSpread={22}
      edgeSensitivity={24}
      glowColor={t.glowColor}
      backgroundColor="#14171c"
      colors={[...t.colors]}
      fillOpacity={0.28}
    >
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay }}
        className="relative flex h-full items-center gap-3 overflow-hidden rounded-[inherit] px-3 py-2.5"
      >
        <span className={cn("absolute inset-y-0 left-0 w-[2px]", t.bar)} />
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md",
            t.chip
          )}
        >
          {icon}
        </div>
        <div className="min-w-0 leading-tight">
          <p className="text-[9px] font-mono uppercase tracking-[0.14em] text-text-muted">
            {label}
          </p>
          <p className="mt-0.5 flex items-baseline gap-1.5 min-w-0">
            <span
              className={cn("text-[15px] font-bold tabular-nums tracking-tight", t.value)}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {value}
            </span>
            {sub && (
              <span className={cn("flex items-center gap-0.5 truncate text-[10px] font-mono", t.sub)}>
                {tone === "up" && <ArrowUpRight className="size-2.5 shrink-0" />}
                {tone === "down" && <ArrowDownRight className="size-2.5 shrink-0" />}
                {sub}
              </span>
            )}
          </p>
        </div>
      </motion.div>
    </BorderGlow>
  );
}

export function MetricCards({ state }: { state: AgentState }) {
  const pnlTone: Tone = state.totalPnl >= 0 ? "up" : "down";
  const dailyTone: Tone = state.dailyPnl >= 0 ? "up" : "down";
  const winTone: Tone =
    state.closedTrades > 0 ? (state.winRate > 50 ? "up" : "down") : "muted";

  return (
    <div className="flex gap-2 overflow-x-auto">
      <Stat
        label="Portfolio"
        value={formatUsd(state.portfolioValue)}
        icon={<Wallet className="size-3.5" />}
        tone="cyan"
        delay={0}
      />
      <Stat
        label="Total PnL"
        value={formatUsd(state.totalPnl)}
        sub={
          state.initialNavUsd > 0
            ? `${formatPct(state.totalPnlPct)} vs ${formatUsd(state.initialNavUsd)}`
            : undefined
        }
        icon={state.totalPnl >= 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
        tone={pnlTone}
        delay={0.04}
      />
      <Stat
        label="Daily PnL"
        value={formatUsd(state.dailyPnl)}
        sub={formatPct(state.dailyPnlPct)}
        icon={<BarChart3 className="size-3.5" />}
        tone={dailyTone}
        delay={0.08}
      />
      <Stat
        label="Trades 24h"
        value={String(state.autonomous.tradesLast24h)}
        sub={`${state.autonomous.tradesToday} today`}
        icon={<Repeat className="size-3.5" />}
        tone="cyan"
        delay={0.12}
      />
      <Stat
        label="Win Rate"
        value={state.closedTrades > 0 ? `${state.winRate.toFixed(1)}%` : "—"}
        sub={
          state.closedTrades > 0
            ? `${state.winCount}W / ${state.lossCount}L`
            : undefined
        }
        icon={<Target className="size-3.5" />}
        tone={winTone}
        delay={0.16}
      />
    </div>
  );
}
