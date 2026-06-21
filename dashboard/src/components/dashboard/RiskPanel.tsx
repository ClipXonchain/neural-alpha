"use client";

import { motion } from "framer-motion";
import {
  Shield,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Gauge,
} from "lucide-react";
import { cn, formatRatio } from "@/lib/utils";
import type { AgentState } from "@/lib/mock-data";

function RiskItem({
  label,
  current,
  max,
  unit,
  passed,
  delay,
}: {
  label: string;
  current: number;
  max: number;
  unit: string;
  passed: boolean;
  delay: number;
}) {
  const safeCurrent = Math.round(current * 100) / 100;
  const pct = Math.min((safeCurrent / max) * 100, 100);
  const isDanger = pct > 80;
  const isWarning = pct > 60;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="py-3"
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          {passed ? (
            <CheckCircle2 className="size-3 text-neon" />
          ) : (
            <XCircle className="size-3 text-danger" />
          )}
          <span className="text-[11px] font-mono text-text-secondary">
            {label}
          </span>
        </div>
        <span
          className={cn(
            "text-[11px] font-mono tabular-nums font-medium",
            isDanger ? "text-danger" : isWarning ? "text-warning" : "text-neon"
          )}
        >
          {formatRatio(safeCurrent, max, unit, unit === "%" ? 1 : 0)}
        </span>
      </div>
      <div className="relative h-1.5 rounded-full bg-surface-overlay overflow-hidden">
        <motion.div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-colors",
            isDanger ? "bg-danger" : isWarning ? "bg-warning" : "bg-neon"
          )}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, delay: delay + 0.2 }}
        />
      </div>
    </motion.div>
  );
}

export function RiskPanel({ state }: { state: AgentState }) {
  const checks = [
    {
      label: "Max Drawdown",
      current: state.currentDrawdownPct,
      max: 25,
      unit: "%",
      passed: state.currentDrawdownPct < 25,
    },
    {
      label: "Daily Trades",
      current: state.todayTrades,
      max: 10,
      unit: "",
      passed: state.todayTrades < 10,
    },
    {
      label: "Open Positions",
      current: state.positions.length,
      max: 5,
      unit: "",
      passed: state.positions.length <= 5,
    },
    {
      label: "Cash Reserve",
      current: Math.round((state.cashBalance / state.portfolioValue) * 100),
      max: 100,
      unit: "%",
      passed: state.cashBalance > 50,
    },
  ];

  const allPassed = checks.every((c) => c.passed);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.45 }}
      className="glass-raised rounded-xl p-5"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Shield className="size-4 text-cyan" />
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Risk Guards
          </h3>
        </div>
        <span
          className={cn(
            "text-[10px] font-mono font-bold px-2 py-0.5 rounded",
            allPassed
              ? "bg-neon/10 text-neon border border-neon/20"
              : "bg-danger/10 text-danger border border-danger/20"
          )}
        >
          {allPassed ? "ALL CLEAR" : "WARNING"}
        </span>
      </div>

      <div className="flex flex-col divide-y divide-border-dim">
        {checks.map((check, i) => (
          <RiskItem
            key={check.label}
            {...check}
            delay={0.5 + i * 0.08}
          />
        ))}
      </div>

      {/* Token Allowlist Status */}
      <div className="mt-3 pt-3 border-t border-border-dim">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-3 text-neon" />
            <span className="text-[11px] font-mono text-text-secondary">
              Token Allowlist
            </span>
          </div>
          <span className="text-[10px] font-mono text-neon">
            149 BEP-20 active
          </span>
        </div>
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-3 text-neon" />
            <span className="text-[11px] font-mono text-text-secondary">
              Honeypot Scanner
            </span>
          </div>
          <span className="text-[10px] font-mono text-neon">
            Active
          </span>
        </div>
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-3 text-neon" />
            <span className="text-[11px] font-mono text-text-secondary">
              Self-Custody (TWAK)
            </span>
          </div>
          <span className="text-[10px] font-mono text-neon">
            Local Signing
          </span>
        </div>
      </div>
    </motion.div>
  );
}
