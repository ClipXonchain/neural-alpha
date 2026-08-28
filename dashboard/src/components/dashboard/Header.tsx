"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  Cpu,
  Eye,
  Play,
  Radio,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/lib/mock-data";
import { clockSession, formatNyTime, sessionLabel } from "@/lib/session";

interface HeaderProps {
  state: AgentState;
  onStart: () => void;
  onStop: () => void;
  connected?: boolean;
  error?: string | null;
  readOnly?: boolean;
}

function useNyTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function Header({ state, onStart, onStop, connected, readOnly }: HeaderProps) {
  const auto = state.autonomous;
  const isRunning = connected && state.status === "running";
  const showOffline = connected === false;
  const now = useNyTick();
  const session = clockSession(now);
  const ny = formatNyTime(now);

  const statusLabel = showOffline
    ? "OFFLINE"
    : !isRunning
      ? "STOPPED"
      : auto.phase === "scanning"
        ? "SCANNING"
        : auto.phase === "blocked"
          ? "BLOCKED"
          : "RUNNING";

  const statusColor = showOffline
    ? "danger"
    : auto.phase === "blocked"
      ? "danger"
      : auto.phase === "scanning"
        ? "cyan"
        : isRunning
          ? "neon"
          : "warning";

  const uptimeHrs = Math.floor(state.uptime / 3600);
  const uptimeMin = Math.floor((state.uptime % 3600) / 60);

  return (
    <header className="glass sticky top-0 z-50 flex items-center justify-between gap-2 px-3 sm:px-6 py-2.5 sm:py-3 pt-[max(0.625rem,env(safe-area-inset-top))]">
      <div className="flex items-center gap-2 sm:gap-4 min-w-0">
        <motion.div
          className="flex items-center gap-2 sm:gap-3 min-w-0"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="relative flex items-center justify-center size-8 sm:size-9 rounded-lg bg-neon/10 border border-neon/20 shrink-0">
            <Cpu className="size-4 sm:size-5 text-neon" />
            {isRunning && (
              <motion.div
                className="absolute inset-0 rounded-lg border border-neon/40"
                animate={{ scale: [1, 1.2, 1], opacity: [0.4, 0, 0.4] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            )}
          </div>
          <div className="min-w-0">
            <h1
              className="text-sm sm:text-lg font-bold tracking-tight truncate"
              style={{ fontFamily: "var(--font-display)" }}
            >
              NEURAL ALPHA
            </h1>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
          className={cn(
            "relative flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-[10px] sm:text-xs font-mono font-medium shrink-0",
            statusColor === "danger" && "bg-danger/10 text-danger border border-danger/20",
            statusColor === "warning" && "bg-warning/10 text-warning border border-warning/20",
            statusColor === "cyan" && "bg-cyan/10 text-cyan border border-cyan/20",
            statusColor === "neon" && "bg-neon/10 text-neon border border-neon/20"
          )}
        >
          <span className="relative flex size-2">
            <span
              className={cn(
                "absolute inline-flex size-full rounded-full opacity-75",
                isRunning && auto.phase === "idle" && "animate-ping bg-neon",
                auto.phase === "scanning" && "animate-ping bg-cyan"
              )}
            />
            <span
              className={cn(
                "relative inline-flex size-2 rounded-full",
                statusColor === "danger" && "bg-danger",
                statusColor === "warning" && "bg-warning",
                statusColor === "cyan" && "bg-cyan",
                statusColor === "neon" && "bg-neon"
              )}
            />
          </span>
          {statusLabel}
        </motion.div>

        <div className="hidden md:flex items-center gap-3 text-xs font-mono text-text-secondary">
          <span
            className={cn(
              "flex items-center gap-1.5 px-2 py-0.5 rounded",
              connected ? "text-neon bg-neon/5" : "text-warning bg-warning/5"
            )}
          >
            <Radio className="size-3" />
            {connected ? "LIVE" : "OFFLINE"}
          </span>
          {connected && (
            <>
              <span className="text-text-muted">|</span>
              <span className="flex items-center gap-1.5">
                <Activity className="size-3 text-neon" />
                Cycle #{state.cycleCount}
              </span>
              <span className="text-text-muted">|</span>
              <span>
                {uptimeHrs}h {uptimeMin}m
              </span>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className={cn(
            "hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg glass-raised text-xs font-mono",
            session === "rth" && "border-neon/25",
            session === "close" && "border-cyan/30",
            session === "overnight" && "border-warning/20"
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              session === "rth" && "bg-neon",
              session === "close" && "bg-cyan",
              session === "overnight" && "bg-warning"
            )}
          />
          <span
            className={cn(
              "font-semibold",
              session === "rth" && "text-neon",
              session === "close" && "text-cyan",
              session === "overnight" && "text-warning"
            )}
          >
            {sessionLabel(session)}
          </span>
          <span className="text-text-muted">{ny}</span>
          <span className="text-text-muted">
            {session === "rth" ? "cash open" : "cash closed"}
          </span>
        </motion.div>

        {readOnly ? (
          <span
            className="flex items-center gap-1.5 min-h-10 px-3 py-2 rounded-lg glass-raised text-[11px] font-mono text-text-muted"
            title="Public dashboard — monitoring only"
          >
            <Eye className="size-3.5" />
            <span className="sm:hidden">VIEW</span>
            <span className="hidden sm:inline">MONITORING</span>
          </span>
        ) : (
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={isRunning ? onStop : onStart}
            className={cn(
              "flex items-center gap-2 min-h-10 px-3 sm:px-4 py-2 rounded-lg font-mono text-xs font-semibold transition-all",
              isRunning
                ? "bg-warning/10 text-warning border border-warning/30 hover:bg-warning/20"
                : "bg-neon/10 text-neon border border-neon/30 hover:bg-neon/20"
            )}
          >
            {isRunning ? (
              <>
                <Square className="size-3.5" /> STOP
              </>
            ) : (
              <>
                <Play className="size-3.5" /> START
              </>
            )}
          </motion.button>
        )}
      </div>
    </header>
  );
}
