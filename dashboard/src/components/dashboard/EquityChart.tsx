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
      <p className="text-[9px] uppercase tracking-wider text-text-muted">Total value</p>
      <p className="text-text-primary font-semibold">
        {formatUsd(payload[0].value)}
      </p>
    </div>
  );
}

export function EquityChart({
  state,
  embedded = false,
  rangeMs,
}: {
  state: AgentState;
  embedded?: boolean;
  rangeMs?: number;
}) {
  const now = Date.now();
  const data = rangeMs
    ? state.equityCurve.filter((point) => !point.ts || point.ts >= now - rangeMs)
    : state.equityCurve;
  const last = data[data.length - 1];
  const initialValue =
    last !== undefined ? Number((last.value - last.pnl).toFixed(2)) : 0;
  const values = data.map((d) => d.value);
  const seriesMin = values.length ? Math.min(...values) : 0;
  const seriesMax = values.length ? Math.max(...values) : 1;
  const pad = Math.max((seriesMax - seriesMin) * 0.18, seriesMax * 0.004, 1);
  const minValue = embedded ? seriesMin - pad : Math.min(seriesMin, initialValue) * 0.995;
  const maxValue = embedded ? seriesMax + pad : Math.max(seriesMax, initialValue) * 1.005;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={embedded ? "min-w-0" : "glass-raised rounded-xl p-3 sm:p-5 col-span-full lg:col-span-3 min-w-0"}
    >
      {!embedded && (
      <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="size-4 text-cyan" />
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Equity Curve
          </h3>
        </div>
      )}

      <div className={embedded ? "h-[268px]" : "h-[200px] sm:h-[280px]"}>
        {data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[11px] text-text-muted" style={{ fontFamily: "var(--font-mono)" }}>
            No NAV history yet
          </div>
        ) : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#12b264" stopOpacity={0.28} />
                <stop offset="100%" stopColor="#12b264" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "#5d6975", fontFamily: "JetBrains Mono, monospace" }}
              axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
              tickLine={false}
              interval={data.length > 8 ? Math.floor(data.length / 8) : 0}
            />
            <YAxis
              width={42}
              domain={[minValue, maxValue]}
              tick={{ fontSize: 10, fill: "#5d6975", fontFamily: "JetBrains Mono, monospace" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${v.toFixed(0)}`}
            />
            <Tooltip content={<CustomTooltip />} />
            {!embedded && initialValue > 0 && (
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
              stroke="#12b264"
              strokeWidth={embedded ? 3 : 2.6}
              fill="url(#equityGrad)"
              animationDuration={800}
              animationEasing="ease-out"
              dot={false}
              activeDot={{
                r: 4,
                fill: "#12b264",
                stroke: "#050608",
                strokeWidth: 2,
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
        )}
      </div>
    </motion.div>
  );
}
