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

interface MetricCardProps {
  label: string;
  value: string;
  subValue?: string;
  icon: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  accentColor?: "neon" | "cyan" | "danger" | "warning";
  delay?: number;
}

function MetricCard({
  label,
  value,
  subValue,
  icon,
  trend,
  accentColor = "neon",
  delay = 0,
}: MetricCardProps) {
  const colors = {
    neon: { bg: "bg-neon/5", text: "text-neon" },
    cyan: { bg: "bg-cyan/5", text: "text-cyan" },
    danger: { bg: "bg-danger/5", text: "text-danger" },
    warning: { bg: "bg-warning/5", text: "text-warning" },
  }[accentColor];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay }}
      whileHover={{ y: -2, transition: { duration: 0.2 } }}
      className={cn(
        "glass-raised rounded-xl p-4 relative overflow-hidden group",
        "hover:border-neon/20 transition-all duration-300"
      )}
    >
      <div
        className="absolute top-0 right-0 w-24 h-24 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background:
            accentColor === "neon"
              ? "rgba(14,203,129,0.08)"
              : accentColor === "cyan"
                ? "rgba(30,159,242,0.08)"
                : accentColor === "danger"
                  ? "rgba(246,70,93,0.08)"
                  : "rgba(240,185,11,0.08)",
        }}
      />

      <div className="flex items-start justify-between mb-3">
        <span className="text-[11px] font-mono uppercase tracking-wider text-text-secondary">
          {label}
        </span>
        <div className={cn("flex items-center justify-center size-8 rounded-lg", colors.bg)}>
          <span className={colors.text}>{icon}</span>
        </div>
      </div>

      <div className="flex items-end gap-2">
        <span
          className="text-2xl font-bold tabular-nums tracking-tight"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {value}
        </span>
        {subValue && (
          <span
            className={cn(
              "text-xs font-mono font-medium mb-0.5 flex items-center gap-0.5",
              trend === "up" ? "text-neon" : trend === "down" ? "text-danger" : "text-text-secondary"
            )}
          >
            {trend === "up" && <ArrowUpRight className="size-3" />}
            {trend === "down" && <ArrowDownRight className="size-3" />}
            {subValue}
          </span>
        )}
      </div>
    </motion.div>
  );
}

export function MetricCards({ state }: { state: AgentState }) {
  const pnlTrend = state.totalPnl >= 0 ? "up" : "down";
  const dailyTrend = state.dailyPnl >= 0 ? "up" : "down";

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
      <MetricCard
        label="Portfolio Value"
        value={formatUsd(state.portfolioValue)}
        subValue={`${formatUsd(state.cashBalance)} cash`}
        icon={<Wallet className="size-4" />}
        trend={pnlTrend}
        accentColor="cyan"
        delay={0}
      />
      <MetricCard
        label="Total PnL"
        value={formatUsd(state.totalPnl)}
        subValue={
          state.initialNavUsd > 0
            ? `${formatPct(state.totalPnlPct)} · vs ${formatUsd(state.initialNavUsd)} deposited`
            : `${formatPct(state.totalPnlPct)} · ${formatUsd(state.realizedPnl)} closed`
        }
        icon={state.totalPnl >= 0 ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
        trend={pnlTrend}
        accentColor={state.totalPnl >= 0 ? "neon" : "danger"}
        delay={0.05}
      />
      <MetricCard
        label="Daily PnL"
        value={formatUsd(state.dailyPnl)}
        subValue={`${formatPct(state.dailyPnlPct)} · vs yesterday`}
        icon={<BarChart3 className="size-4" />}
        trend={dailyTrend}
        accentColor={state.dailyPnl >= 0 ? "neon" : "danger"}
        delay={0.1}
      />
      <MetricCard
        label="Trades 24h"
        value={String(state.autonomous.tradesLast24h)}
        subValue={`${state.autonomous.tradesToday} today`}
        icon={<Repeat className="size-4" />}
        trend="neutral"
        accentColor="cyan"
        delay={0.18}
      />
      <MetricCard
        label="Win Rate"
        value={state.closedTrades > 0 ? `${state.winRate.toFixed(1)}%` : "—"}
        subValue={
          state.closedTrades > 0
            ? `${state.winCount}W / ${state.lossCount}L · ${state.closedTrades} sells`
            : `${state.totalTrades} swaps`
        }
        icon={<Target className="size-4" />}
        trend={state.closedTrades > 0 ? (state.winRate > 50 ? "up" : "down") : "neutral"}
        accentColor={state.closedTrades > 0 ? (state.winRate > 50 ? "neon" : "warning") : "cyan"}
        delay={0.2}
      />
    </div>
  );
}
