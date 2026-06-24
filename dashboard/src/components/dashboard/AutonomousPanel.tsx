"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Bot,
  Clock,
  AlertTriangle,
  Zap,
  Repeat,
  Activity,
  ShieldAlert,
  Target,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/lib/mock-data";

function formatCountdown(totalSec: number): string {
  if (totalSec <= 0) return "now";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    if (m > 0 && s > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${h}h ${m}m`;
    if (s > 0) return `${h}h ${s}s`;
    return `${h}h`;
  }
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Tick every second from a wall-clock deadline (ms). */
function useCountdownTo(deadlineMs: number | null): number | null {
  const [remainingSec, setRemainingSec] = useState<number | null>(() =>
    deadlineMs !== null ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)) : null
  );

  useEffect(() => {
    if (deadlineMs === null) {
      setRemainingSec(null);
      return;
    }
    const tick = () =>
      setRemainingSec(Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadlineMs]);

  return remainingSec;
}

function phaseStyle(phase: AgentState["autonomous"]["phase"]) {
  switch (phase) {
    case "scanning":
      return { dot: "bg-cyan animate-pulse", text: "text-cyan", bg: "bg-cyan/10 border-cyan/25" };
    case "warming":
      return { dot: "bg-warning animate-pulse", text: "text-warning", bg: "bg-warning/10 border-warning/25" };
    case "blocked":
      return { dot: "bg-danger", text: "text-danger", bg: "bg-danger/10 border-danger/25" };
    case "stopped":
      return { dot: "bg-text-muted", text: "text-text-muted", bg: "bg-surface/80 border-white/10" };
    default:
      return { dot: "bg-neon", text: "text-neon", bg: "bg-neon/10 border-neon/25" };
  }
}

function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-surface/50 border border-white/5 px-3 py-2.5 min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wide text-text-muted mb-1">
        {icon}
        {label}
      </div>
      <div className="text-sm font-mono font-semibold text-text-primary tabular-nums truncate">
        {value}
      </div>
      {sub && (
        <div className="text-[10px] font-mono text-text-muted mt-0.5 truncate">{sub}</div>
      )}
    </div>
  );
}

export function AutonomousPanel({ state }: { state: AgentState }) {
  const auto = state.autonomous;
  const style = phaseStyle(auto.phase);

  const inWarmup =
    auto.phase === "warming" ||
    (state.startedAt !== null &&
      state.startedAt + state.startupCooldownMs > Date.now());

  const warmupDeadline =
    inWarmup && state.startedAt !== null
      ? state.startedAt + state.startupCooldownMs
      : null;

  const warmupSec = useCountdownTo(warmupDeadline);

  const nextCycleDeadline =
    !inWarmup && auto.lastCycleAt && auto.tradeIntervalSec > 0 && state.status === "running"
      ? auto.lastCycleAt + auto.tradeIntervalSec * 1000
      : null;

  const nextCycleSec = useCountdownTo(nextCycleDeadline);

  const headline =
    inWarmup && warmupSec !== null
      ? `Warming up — autonomous trades in ${formatCountdown(warmupSec)}`
      : auto.headline;

  const blockReason =
    inWarmup && warmupSec !== null
      ? `Startup cooldown (${formatCountdown(warmupSec)} remaining)`
      : auto.blockReason;

  const nextLabel =
    auto.phase === "scanning"
      ? "Cycle in progress…"
      : inWarmup && warmupSec !== null
        ? formatCountdown(warmupSec)
        : nextCycleSec !== null
          ? formatCountdown(nextCycleSec)
          : state.status === "running"
            ? "starting…"
            : "—";

  const nextSub = inWarmup
    ? "trades unlock after warmup"
    : `every ${formatCountdown(auto.tradeIntervalSec)}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={cn("glass-raised rounded-xl border p-4 md:p-5", style.bg)}
    >
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <Bot className={cn("size-4 shrink-0", style.text)} />
            <span className="text-[10px] font-mono uppercase tracking-widest text-text-muted">
              Autonomous Engine
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase border",
                style.bg,
                style.text
              )}
            >
              <span className={cn("size-1.5 rounded-full", style.dot)} />
              {inWarmup ? "warming" : auto.phase}
            </span>
            {auto.ready && !inWarmup && (
              <span className="text-[10px] font-mono text-neon/80">READY</span>
            )}
          </div>
          <p className={cn("text-sm font-mono font-medium leading-snug", style.text)}>
            {headline}
          </p>
          {blockReason && (inWarmup || auto.phase !== "idle") && (
            <p className="mt-1.5 text-xs font-mono text-text-secondary flex items-start gap-1.5">
              <AlertTriangle className="size-3 shrink-0 mt-0.5 text-warning" />
              {blockReason}
            </p>
          )}
          {auto.competitionNudge && (
            <p className="mt-2 text-[11px] font-mono text-warning/90 flex items-center gap-1.5">
              <Target className="size-3 shrink-0" />
              Competition: no trades yet today — agent may force a trade after 20:00 UTC
            </p>
          )}
          {auto.failedSwapCooldowns.length > 0 && (
            <p className="mt-2 text-[11px] font-mono text-text-muted">
              Swap cooldown:{" "}
              {auto.failedSwapCooldowns
                .map((c) => `${c.symbol} (${c.remainingMin}m)`)
                .join(", ")}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 lg:max-w-[720px] w-full shrink-0">
          <Stat
            label="Trades 24h"
            value={String(auto.tradesLast24h)}
            sub={`${auto.tradesToday}/${auto.maxTradesToday} today`}
            icon={<Repeat className="size-3" />}
          />
          <Stat
            label="Tx budget"
            value={`${auto.txsToday}/${auto.maxTxsToday}`}
            sub={`~${auto.swapsRemainingToday} swaps left`}
            icon={<Zap className="size-3" />}
          />
          <Stat
            label={inWarmup ? "Warmup" : "Next cycle"}
            value={nextLabel}
            sub={nextSub}
            icon={<Clock className="size-3" />}
          />
          <Stat
            label="Last cycle"
            value={
              auto.lastCycleDurationSec !== null
                ? `${auto.lastCycleDurationSec}s`
                : "—"
            }
            sub={
              auto.lastCycleTrades > 0
                ? `${auto.lastCycleTrades} trade(s) · ${auto.lastCycleQueued} queued`
                : auto.lastCycleQueued > 0
                  ? `0/${auto.lastCycleQueued} executed`
                  : "no signals"
            }
            icon={<Activity className="size-3" />}
          />
          <Stat
            label="Strategy"
            value={auto.strategy.toUpperCase()}
            sub={`${auto.maxPerCycle}/cycle · ${auto.autoExitEnabled ? "auto-exit on" : "auto-exit off"}`}
            icon={<Bot className="size-3" />}
          />
          <Stat
            label="Drawdown"
            value={`${state.currentDrawdownPct.toFixed(1)}%`}
            sub={`limit ${state.maxDrawdownLimit}%${auto.emergencyMode ? " · EMERGENCY" : ""}`}
            icon={<ShieldAlert className="size-3" />}
          />
        </div>
      </div>
    </motion.div>
  );
}
