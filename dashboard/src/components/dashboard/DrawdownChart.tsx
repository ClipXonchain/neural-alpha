"use client";

import { motion } from "framer-motion";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { ShieldAlert } from "lucide-react";
import type { AgentState } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

function DDTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-raised rounded-lg px-3 py-2 text-xs font-mono border border-danger/20">
      <p className="text-text-secondary mb-1">{label}</p>
      <p className="text-danger font-semibold">
        -{payload[0].value.toFixed(2)}%
      </p>
    </div>
  );
}

export function DrawdownChart({ state }: { state: AgentState }) {
  const data = state.drawdownCurve;
  const currentDD = data[data.length - 1]?.drawdown || 0;
  const isDanger = currentDD > 15;
  const isWarning = currentDD > 10;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.35 }}
      className="glass-raised rounded-xl p-5 col-span-full lg:col-span-2"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ShieldAlert
            className={cn(
              "size-4",
              isDanger ? "text-danger" : isWarning ? "text-warning" : "text-cyan"
            )}
          />
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Drawdown
          </h3>
        </div>
        <span
          className={cn(
            "text-xs font-mono font-semibold px-2 py-0.5 rounded",
            isDanger
              ? "bg-danger/10 text-danger"
              : isWarning
                ? "bg-warning/10 text-warning"
                : "bg-neon/10 text-neon"
          )}
        >
          {currentDD.toFixed(1)}% / 25%
        </span>
      </div>

      {/* Drawdown gauge bar */}
      <div className="mb-4">
        <div className="relative h-2 rounded-full bg-surface-overlay overflow-hidden">
          <motion.div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              isDanger ? "bg-danger" : isWarning ? "bg-warning" : "bg-cyan"
            )}
            initial={{ width: 0 }}
            animate={{ width: `${(currentDD / 25) * 100}%` }}
            transition={{ duration: 1, ease: "easeOut" }}
          />
          <div
            className="absolute inset-y-0 w-0.5 bg-danger/60"
            style={{ left: "80%" }}
          />
          <div
            className="absolute inset-y-0 w-0.5 bg-danger"
            style={{ left: "100%" }}
          />
        </div>
        <div className="flex justify-between mt-1 text-[9px] font-mono text-text-muted">
          <span>0%</span>
          <span className="text-warning">20% buffer</span>
          <span className="text-danger">25% max</span>
        </div>
      </div>

      <div className="h-[190px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
            <defs>
              <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f6465d" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#f6465d" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 9, fill: "#848e9c", fontFamily: "IBM Plex Mono" }}
              axisLine={false}
              tickLine={false}
              interval={Math.floor(data.length / 6)}
            />
            <YAxis
              reversed
              domain={[0, 30]}
              tick={{ fontSize: 9, fill: "#848e9c", fontFamily: "IBM Plex Mono" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip content={<DDTooltip />} />
            <ReferenceLine
              y={25}
              stroke="#f6465d"
              strokeDasharray="4 4"
              strokeWidth={1.5}
            />
            <ReferenceLine
              y={20}
              stroke="#f0b90b"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
            <Area
              type="monotone"
              dataKey="drawdown"
              stroke="#f6465d"
              strokeWidth={1.5}
              fill="url(#ddGrad)"
              animationDuration={2000}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
}
