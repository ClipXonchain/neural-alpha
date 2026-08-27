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

interface StatProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  tone?: "up" | "down" | "muted";
}

function Stat({ label, value, sub, icon, tone = "muted" }: StatProps) {
  const toneClass =
    tone === "up" ? "text-neon" : tone === "down" ? "text-danger" : "text-text-primary";

  return (
    <div className="flex items-center gap-2.5 min-w-0 px-3 py-2 shrink-0">
      <span className="text-text-muted shrink-0">{icon}</span>
      <div className="min-w-0 leading-tight">
        <p className="text-[9px] font-mono uppercase tracking-wider text-text-muted">{label}</p>
        <p className="flex items-baseline gap-1.5 min-w-0">
          <span
            className={cn("text-sm font-bold tabular-nums tracking-tight", toneClass)}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {value}
          </span>
          {sub && (
            <span
              className={cn(
                "text-[10px] font-mono truncate flex items-center gap-0.5",
                tone === "up" ? "text-neon/80" : tone === "down" ? "text-danger/80" : "text-text-muted"
              )}
            >
              {tone === "up" && <ArrowUpRight className="size-2.5 shrink-0" />}
              {tone === "down" && <ArrowDownRight className="size-2.5 shrink-0" />}
              {sub}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

export function MetricCards({ state }: { state: AgentState }) {
  const pnlTone = state.totalPnl >= 0 ? "up" : "down";
  const dailyTone = state.dailyPnl >= 0 ? "up" : "down";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="glass-raised rounded-xl overflow-x-auto"
    >
      <div className="flex items-stretch min-w-max divide-x divide-border-dim/60 md:min-w-0 md:grid md:grid-cols-5">
        <Stat
          label="Portfolio"
          value={formatUsd(state.portfolioValue)}
          icon={<Wallet className="size-3.5" />}
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
        />
        <Stat
          label="Daily PnL"
          value={formatUsd(state.dailyPnl)}
          sub={formatPct(state.dailyPnlPct)}
          icon={<BarChart3 className="size-3.5" />}
          tone={dailyTone}
        />
        <Stat
          label="Trades 24h"
          value={String(state.autonomous.tradesLast24h)}
          sub={`${state.autonomous.tradesToday} today`}
          icon={<Repeat className="size-3.5" />}
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
          tone={
            state.closedTrades > 0
              ? state.winRate > 50
                ? "up"
                : "down"
              : "muted"
          }
        />
      </div>
    </motion.div>
  );
}
