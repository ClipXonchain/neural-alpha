"use client";

import { motion } from "framer-motion";
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  BarChart3,
  ShieldAlert,
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
    neon: { bg: "bg-neon/5", border: "border-neon/15", text: "text-neon", glow: "glow-neon" },
    cyan: { bg: "bg-cyan/5", border: "border-cyan/15", text: "text-cyan", glow: "glow-cyan" },
    danger: { bg: "bg-danger/5", border: "border-danger/15", text: "text-danger", glow: "glow-danger" },
    warning: { bg: "bg-warning/5", border: "border-warning/15", text: "text-warning", glow: "" },
  }[accentColor];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay }}
      whileHover={{ y: -2, transition: { duration: 0.2 } }}
      className={cn(
        "glass-raised rounded-xl p-4 relative overflow-hidden group",
        "hover:border-neon/20 transition-all duration-300"
      )}
    >
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ background: accentColor === "neon" ? "rgba(0,255,136,0.05)" : accentColor === "cyan" ? "rgba(0,212,255,0.05)" : accentColor === "danger" ? "rgba(255,51,102,0.05)" : "rgba(255,170,0,0.05)" }}
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
    <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3">
      <MetricCard
        label="Portfolio Value"
        value={formatUsd(state.portfolioValue)}
        subValue={formatPct(state.totalPnlPct)}
        icon={<Wallet className="size-4" />}
        trend={pnlTrend}
        accentColor="cyan"
        delay={0}
      />
      <MetricCard
        label="Total PnL"
        value={formatUsd(state.totalPnl)}
        subValue={formatPct(state.totalPnlPct)}
        icon={state.totalPnl >= 0 ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
        trend={pnlTrend}
        accentColor={state.totalPnl >= 0 ? "neon" : "danger"}
        delay={0.05}
      />
      <MetricCard
        label="Daily PnL"
        value={formatUsd(state.dailyPnl)}
        subValue={formatPct(state.dailyPnlPct)}
        icon={<BarChart3 className="size-4" />}
        trend={dailyTrend}
        accentColor={state.dailyPnl >= 0 ? "neon" : "danger"}
        delay={0.1}
      />
      <MetricCard
        label="Max Drawdown"
        value={formatPct(state.maxDrawdownPct).replace("+", "")}
        subValue={`Current: ${state.currentDrawdownPct.toFixed(1)}%`}
        icon={<ShieldAlert className="size-4" />}
        trend={state.currentDrawdownPct > 15 ? "down" : "neutral"}
        accentColor={state.currentDrawdownPct > 15 ? "danger" : "warning"}
        delay={0.15}
      />
      <MetricCard
        label="Win Rate"
        value={`${state.winRate.toFixed(1)}%`}
        subValue={`${state.totalTrades} trades`}
        icon={<Target className="size-4" />}
        trend={state.winRate > 50 ? "up" : "down"}
        accentColor={state.winRate > 50 ? "neon" : "warning"}
        delay={0.2}
      />
    </div>
  );
}
