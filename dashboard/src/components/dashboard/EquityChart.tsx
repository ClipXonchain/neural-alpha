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
import { TrendingUp } from "lucide-react";
import type { AgentState } from "@/lib/mock-data";
import { formatUsd } from "@/lib/utils";

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-raised rounded-lg px-3 py-2 text-xs font-mono border border-neon/20">
      <p className="text-text-secondary mb-1">{label}</p>
      <p className="text-text-primary font-semibold">
        {formatUsd(payload[0].value)}
      </p>
      <p className={payload[0].payload.pnl >= 0 ? "text-neon" : "text-danger"}>
        PnL: {payload[0].payload.pnl >= 0 ? "+" : ""}
        {formatUsd(payload[0].payload.pnl)}
      </p>
    </div>
  );
}

export function EquityChart({ state }: { state: AgentState }) {
  const data = state.equityCurve;
  const last = data[data.length - 1];
  // Initial NAV baseline: value − pnl is constant across the curve.
  const initialValue =
    last !== undefined ? Number((last.value - last.pnl).toFixed(2)) : 0;
  const values = data.map((d) => d.value);
  const minValue = Math.min(...values, initialValue) * 0.995;
  const maxValue = Math.max(...values, initialValue) * 1.005;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      className="glass-raised rounded-xl p-5 col-span-full lg:col-span-3"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="size-4 text-cyan" />
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Equity Curve
          </h3>
        </div>
        <div className="flex items-center gap-4 text-xs font-mono">
          <button className="text-text-secondary hover:text-text-primary transition-colors">
            1H
          </button>
          <button className="text-text-secondary hover:text-text-primary transition-colors">
            6H
          </button>
          <button className="text-neon">24H</button>
          <button className="text-text-secondary hover:text-text-primary transition-colors">
            7D
          </button>
          <button className="text-text-secondary hover:text-text-primary transition-colors">
            ALL
          </button>
        </div>
      </div>

      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
            <defs>
              <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0ecb81" stopOpacity={0.2} />
                <stop offset="50%" stopColor="#0ecb81" stopOpacity={0.05} />
                <stop offset="100%" stopColor="#0ecb81" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "#848e9c", fontFamily: "IBM Plex Mono" }}
              axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
              tickLine={false}
              interval={Math.floor(data.length / 8)}
            />
            <YAxis
              domain={[minValue, maxValue]}
              tick={{ fontSize: 10, fill: "#848e9c", fontFamily: "IBM Plex Mono" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${v.toFixed(0)}`}
            />
            <Tooltip content={<CustomTooltip />} />
            {initialValue > 0 && (
              <ReferenceLine
                y={initialValue}
                stroke="rgba(30,159,242,0.4)"
                strokeDasharray="6 4"
                label={{
                  value: "Initial",
                  position: "right",
                  fill: "#b7bdc6",
                  fontSize: 10,
                  fontFamily: "IBM Plex Mono",
                }}
              />
            )}
            <Area
              type="monotone"
              dataKey="value"
              stroke="#0ecb81"
              strokeWidth={2}
              fill="url(#equityGrad)"
              animationDuration={2000}
              animationEasing="ease-out"
              dot={false}
              activeDot={{
                r: 4,
                fill: "#0ecb81",
                stroke: "#0b0e11",
                strokeWidth: 2,
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
}
