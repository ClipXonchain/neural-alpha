"use client";

import { motion } from "framer-motion";
import {
  Activity,
  Cpu,
  Eye,
  Play,
  Radio,
  Settings,
  Square,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/lib/mock-data";

interface HeaderProps {
  state: AgentState;
  onStart: () => void;
  onStop: () => void;
  connected?: boolean;
  error?: string | null;
  readOnly?: boolean;
}

export function Header({ state, onStart, onStop, connected, readOnly }: HeaderProps) {
  const isRunning = state.status === "running";

  const uptimeHrs = Math.floor(state.uptime / 3600);
  const uptimeMin = Math.floor((state.uptime % 3600) / 60);

  return (
    <header className="glass sticky top-0 z-50 flex items-center justify-between px-6 py-3">
      <div className="flex items-center gap-4">
        {/* Logo */}
        <motion.div
          className="flex items-center gap-3"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="relative flex items-center justify-center size-9 rounded-lg bg-neon/10 border border-neon/20">
            <Cpu className="size-5 text-neon" />
            {isRunning && (
              <motion.div
                className="absolute inset-0 rounded-lg border border-neon/40"
                animate={{ scale: [1, 1.2, 1], opacity: [0.4, 0, 0.4] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            )}
          </div>
          <div>
            <h1
              className="text-lg font-bold tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              NEURAL ALPHA
            </h1>
          </div>
        </motion.div>

        {/* Status Badge */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
          className={cn(
            "relative flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono font-medium",
            isRunning
              ? "bg-neon/10 text-neon border border-neon/20"
              : "bg-warning/10 text-warning border border-warning/20"
          )}
        >
          <span className="relative flex size-2">
            <span
              className={cn(
                "absolute inline-flex size-full rounded-full opacity-75",
                isRunning && "animate-ping bg-neon"
              )}
            />
            <span
              className={cn(
                "relative inline-flex size-2 rounded-full",
                isRunning ? "bg-neon" : "bg-warning"
              )}
            />
          </span>
          {isRunning ? "RUNNING" : "STOPPED"}
        </motion.div>

        <div className="hidden md:flex items-center gap-3 text-xs font-mono text-text-secondary">
          <span
            className={cn(
              "flex items-center gap-1.5 px-2 py-0.5 rounded",
              connected ? "text-neon bg-neon/5" : "text-warning bg-warning/5"
            )}
          >
            <Radio className="size-3" />
            {connected ? "LIVE" : "DEMO"}
          </span>
          <span className="text-text-muted">|</span>
          <span className="flex items-center gap-1.5">
            <Activity className="size-3 text-neon" />
            Cycle #{state.cycleCount}
          </span>
          <span className="text-text-muted">|</span>
          <span>
            {uptimeHrs}h {uptimeMin}m
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Fear & Greed Badge */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-lg glass-raised text-xs font-mono"
        >
          <Zap
            className={cn(
              "size-3",
              state.fearGreedIndex < 30
                ? "text-danger"
                : state.fearGreedIndex < 50
                  ? "text-warning"
                  : "text-neon"
            )}
          />
          <span className="text-text-secondary">F&G</span>
          <span
            className={cn(
              "font-semibold",
              state.fearGreedIndex < 30
                ? "text-danger"
                : state.fearGreedIndex < 50
                  ? "text-warning"
                  : "text-neon"
            )}
          >
            {state.fearGreedIndex}
          </span>
          <span className="text-text-muted">
            {state.fearGreedIndex < 25
              ? "Extreme Fear"
              : state.fearGreedIndex < 45
                ? "Fear"
                : state.fearGreedIndex < 55
                  ? "Neutral"
                  : state.fearGreedIndex < 75
                    ? "Greed"
                    : "Extreme Greed"}
          </span>
        </motion.div>

        {/* Controls — hidden on public/read-only deployments */}
        {readOnly ? (
          <span
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass-raised text-[11px] font-mono text-text-muted"
            title="Public dashboard — monitoring only"
          >
            <Eye className="size-3.5" /> MONITORING
          </span>
        ) : (
          <>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={isRunning ? onStop : onStart}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-xs font-semibold transition-all",
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

            <button className="flex items-center justify-center size-9 rounded-lg glass-raised text-text-secondary hover:text-text-primary transition-colors">
              <Settings className="size-4" />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
