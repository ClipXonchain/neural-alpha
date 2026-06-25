"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Brain,
  ArrowLeftRight,
  Radar,
  ShieldAlert,
  Info,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Filter,
  Pause,
  Play,
  Sparkles,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import type { ActivityItem } from "@/lib/mock-data";

type LogLevel = ActivityItem["type"];

const LEVEL_CONFIG: Record<
  LogLevel,
  { icon: typeof Brain; label: string; color: string; bgColor: string }
> = {
  brain: {
    icon: Sparkles,
    label: "THINK",
    color: "text-violet-300",
    bgColor: "bg-violet-500/12",
  },
  trade: {
    icon: ArrowLeftRight,
    label: "TRADE",
    color: "text-neon",
    bgColor: "bg-neon/10",
  },
  signal: {
    icon: Radar,
    label: "SCAN",
    color: "text-cyan",
    bgColor: "bg-cyan/10",
  },
  risk: {
    icon: ShieldAlert,
    label: "RISK",
    color: "text-warning",
    bgColor: "bg-warning/10",
  },
  info: {
    icon: Info,
    label: "INFO",
    color: "text-text-secondary",
    bgColor: "bg-surface-overlay",
  },
  error: {
    icon: AlertTriangle,
    label: "ERROR",
    color: "text-danger",
    bgColor: "bg-danger/10",
  },
};

const DEFAULT_FILTERS: LogLevel[] = ["brain", "trade", "signal", "risk", "error"];

function BrainEntry({ item }: { item: ActivityItem }) {
  const [expanded, setExpanded] = useState(false);
  const config = LEVEL_CONFIG[item.type];
  const Icon = config.icon;
  const hasDetail = !!item.detail;
  const isBrain = item.type === "brain";

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn(
        "group flex gap-3 py-3 px-3 rounded-lg transition-colors border border-transparent",
        "hover:bg-surface-overlay/50 hover:border-border-dim/60",
        item.type === "error" && "bg-danger/[0.04] border-danger/10",
        isBrain && "bg-violet-500/[0.04]"
      )}
    >
      <div className="flex flex-col items-center gap-1 shrink-0 w-10 pt-0.5">
        <span
          className={cn(
            "flex items-center justify-center size-7 rounded-lg",
            config.bgColor
          )}
        >
          <Icon className={cn("size-3.5", config.color)} />
        </span>
        <span
          className="text-[9px] text-text-muted tabular-nums text-center leading-tight"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {new Date(item.timestamp).toLocaleTimeString("en", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-1.5">
          {hasDetail && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="mt-1 shrink-0 text-text-muted hover:text-text-primary transition-colors"
            >
              {expanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
          )}
          <p
            className={cn(
              "text-[13px] leading-relaxed",
              item.type === "error" ? "text-danger" : "text-text-primary",
              isBrain && "text-text-primary"
            )}
          >
            {item.message}
          </p>
        </div>

        {hasDetail && expanded && (
          <motion.pre
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            className="mt-2 text-[10px] text-text-muted leading-relaxed p-2.5 rounded-md bg-surface-overlay/70 overflow-x-auto whitespace-pre-wrap break-all border border-border-dim/40"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {formatDetail(item.detail!)}
          </motion.pre>
        )}

        <span
          className="text-[9px] text-text-muted mt-1 inline-block opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {timeAgo(item.timestamp)}
        </span>
      </div>

      {!isBrain && (
        <span
          className={cn(
            "text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 h-fit mt-1",
            config.bgColor,
            config.color
          )}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {config.label}
        </span>
      )}
    </motion.div>
  );
}

function formatDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

export function ActivityFeed({ activity }: { activity: ActivityItem[] }) {
  const [filters, setFilters] = useState<Set<LogLevel>>(new Set(DEFAULT_FILTERS));
  const [paused, setPaused] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filteredItems = activity.filter((item) => filters.has(item.type));

  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [activity.length, paused]);

  const toggleFilter = (level: LogLevel) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        if (next.size > 1) next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  const levelCounts = activity.reduce(
    (acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.5 }}
      className="glass-raised rounded-xl p-5 flex flex-col"
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center size-7 rounded-lg bg-violet-500/12">
            <Brain className="size-3.5 text-violet-300" />
          </div>
          <div>
            <h3
              className="text-sm font-semibold tracking-wide"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Agent Brain
            </h3>
            <p className="text-[10px] text-text-muted mt-0.5">
              Decisions & trades in plain language
            </p>
          </div>
          <span
            className="text-[10px] text-text-muted tabular-nums ml-1"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {filteredItems.length} shown
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused(!paused)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-semibold transition-colors",
              paused
                ? "bg-warning/10 text-warning border border-warning/20"
                : "bg-surface-overlay text-text-secondary hover:text-text-primary border border-border-dim"
            )}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
            {paused ? "Resume" : "Pause"}
          </button>

          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-semibold transition-colors border",
              showFilters
                ? "bg-cyan/10 text-cyan border-cyan/20"
                : "bg-surface-overlay text-text-secondary hover:text-text-primary border-border-dim"
            )}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            <Filter className="size-3" />
            Filter
          </button>

          <div className="flex items-center gap-1.5 ml-1">
            <span className="relative flex size-2">
              <span
                className={cn(
                  "absolute inline-flex size-full rounded-full opacity-75",
                  paused ? "bg-warning" : "animate-ping bg-violet-400"
                )}
              />
              <span
                className={cn(
                  "relative inline-flex size-2 rounded-full",
                  paused ? "bg-warning" : "bg-violet-400"
                )}
              />
            </span>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-2 py-3 border-b border-border-dim mb-2">
              {(Object.keys(LEVEL_CONFIG) as LogLevel[]).map((level) => {
                const cfg = LEVEL_CONFIG[level];
                const active = filters.has(level);
                const count = levelCounts[level] || 0;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => toggleFilter(level)}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-semibold transition-all border",
                      active
                        ? `${cfg.bgColor} ${cfg.color} border-current/20`
                        : "bg-surface-overlay/50 text-text-muted border-border-dim opacity-50 hover:opacity-75"
                    )}
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {cfg.label}
                    <span className="text-[9px] opacity-70">({count})</span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        ref={scrollRef}
        className="flex flex-col gap-1 max-h-[480px] overflow-y-auto pr-1 scroll-smooth mt-2"
      >
        {filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 text-center gap-2">
            <Brain className="size-8 text-text-muted/40" />
            <span className="text-xs text-text-muted max-w-xs">
              Waiting for the agent&apos;s next decision…
            </span>
          </div>
        ) : (
          filteredItems.map((item) => (
            <BrainEntry key={item.id} item={item} />
          ))
        )}
      </div>

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border-dim">
        <span className="text-[10px] text-text-muted">
          {paused ? "Paused — new thoughts still arrive" : "Live decision stream"}
        </span>
        <div
          className="flex items-center gap-3 text-[9px] text-text-muted"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span>{levelCounts["brain"] || 0} thoughts</span>
          <span>{levelCounts["trade"] || 0} trades</span>
          <span>{levelCounts["error"] || 0} errors</span>
        </div>
      </div>
    </motion.div>
  );
}
