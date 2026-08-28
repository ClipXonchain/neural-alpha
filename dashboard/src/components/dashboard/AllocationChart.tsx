"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { PieChart as PieIcon, RefreshCw } from "lucide-react";
import type { AgentState } from "@/lib/mock-data";
import { cn, formatUsd } from "@/lib/utils";

const SLICE_COLORS = [
  "#0ecb81",
  "#1e9ff2",
  "#f0b90b",
  "#9d6bff",
  "#ff5c8a",
  "#2dd4bf",
  "#f6465d",
];
const CASH_COLOR = "#3a4250";
const MIN_SLICE_USD = 1;

interface Slice {
  name: string;
  value: number;
  pct: number;
  isCash?: boolean;
}

function positionValue(p: AgentState["positions"][number]): number {
  return p.amount * p.currentPrice;
}

function AllocTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const slice = payload[0].payload as Slice;
  return (
    <div className="glass-raised rounded-lg px-3 py-2 text-xs font-mono border border-neon/20">
      <p className="text-text-primary font-semibold mb-0.5">{slice.name}</p>
      <p className="text-text-secondary">{formatUsd(slice.value)}</p>
      <p className="text-cyan">{slice.pct.toFixed(1)}% of NAV</p>
    </div>
  );
}

export function AllocationChart({
  state,
  onRefresh,
}: {
  state: AgentState;
  onRefresh?: () => Promise<void> | void;
}) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const nav = state.portfolioValue;
  const meaningfulPositions = state.positions.filter(
    (p) => positionValue(p) >= MIN_SLICE_USD
  );

  const slices: Slice[] = meaningfulPositions
    .map((p) => {
      const value = positionValue(p);
      return {
        name: p.symbol,
        value,
        pct: nav > 0 ? (value / nav) * 100 : 0,
      };
    })
    .sort((a, b) => b.value - a.value);

  if (state.cashBalance >= MIN_SLICE_USD) {
    slices.push({
      name: "Cash (USDT)",
      value: state.cashBalance,
      pct: nav > 0 ? (state.cashBalance / nav) * 100 : 0,
      isCash: true,
    });
  }

  const gasUsd = state.gasReserveUsd ?? 0;
  if (gasUsd >= MIN_SLICE_USD) {
    slices.push({
      name: "Gas (BNB)",
      value: gasUsd,
      pct: nav > 0 ? (gasUsd / nav) * 100 : 0,
      isCash: true,
    });
  }

  const hasData = slices.length > 0 && nav > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.35 }}
      className="glass-raised rounded-xl p-3 sm:p-5 col-span-full lg:col-span-2 min-w-0"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <PieIcon className="size-4 text-cyan" />
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Asset Allocation
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-cyan/10 text-cyan">
            {formatUsd(nav)}
          </span>
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Hard refresh — re-sync on-chain holdings"
              className={cn(
                "flex items-center justify-center size-9 rounded-md transition-colors",
                "bg-surface-overlay/60 text-text-muted hover:text-cyan hover:bg-cyan/10",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            </button>
          )}
        </div>
      </div>

      {hasData ? (
        <div className="flex flex-col items-center sm:flex-row sm:items-start gap-4">
          <div className="h-[190px] w-[190px] shrink-0 relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={52}
                  outerRadius={82}
                  paddingAngle={2}
                  stroke="none"
                  animationDuration={900}
                >
                  {slices.map((s, i) => (
                    <Cell
                      key={s.name}
                      fill={s.isCash ? CASH_COLOR : SLICE_COLORS[i % SLICE_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip content={<AllocTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-[9px] font-mono uppercase tracking-wider text-text-muted">
                Positions
              </span>
              <span
                className="text-lg font-bold tabular-nums"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {meaningfulPositions.length}
              </span>
            </div>
          </div>

          <div className="w-full sm:flex-1 min-w-0 max-h-[190px] overflow-y-auto space-y-2 pr-1">
            {slices.map((s, i) => (
              <div key={s.name} className="flex items-center gap-2 text-xs">
                <span
                  className="size-2.5 rounded-sm shrink-0"
                  style={{
                    background: s.isCash
                      ? CASH_COLOR
                      : SLICE_COLORS[i % SLICE_COLORS.length],
                  }}
                />
                <span
                  className={cn(
                    "font-mono truncate",
                    s.isCash ? "text-text-muted" : "text-text-primary"
                  )}
                >
                  {s.name}
                </span>
                <span className="ml-auto font-mono tabular-nums text-text-secondary">
                  {s.pct.toFixed(1)}%
                </span>
                <span className="font-mono tabular-nums text-text-muted w-16 text-right">
                  {formatUsd(s.value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="h-[190px] flex flex-col items-center justify-center text-center gap-2">
          <PieIcon className="size-8 text-text-muted/40" />
          <p className="text-xs font-mono text-text-muted">
            No open positions yet
          </p>
          <p className="text-[10px] font-mono text-text-muted/60">
            Allocation appears once the agent holds tokens
          </p>
        </div>
      )}
    </motion.div>
  );
}
