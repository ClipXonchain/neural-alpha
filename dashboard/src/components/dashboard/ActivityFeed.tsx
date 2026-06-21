"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal,
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
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import type { ActivityItem } from "@/lib/mock-data";

type LogLevel = ActivityItem["type"];

const LEVEL_CONFIG: Record<
  LogLevel,
  { icon: typeof Terminal; label: string; color: string; bgColor: string }
> = {
  trade: {
    icon: ArrowLeftRight,
    label: "TRADE",
    color: "text-neon",
    bgColor: "bg-neon/10",
  },
  signal: {
    icon: Radar,
    label: "SIGNAL",
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

function LogEntry({
  item,
  index,
}: {
  item: ActivityItem;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const config = LEVEL_CONFIG[item.type];
  const Icon = config.icon;
  const hasDetail = !!item.detail;

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className={cn(
        "group flex gap-3 py-2 px-3 rounded-md transition-colors cursor-default",
        "hover:bg-surface-overlay/40",
        item.type === "error" && "bg-danger/[0.03]"
      )}
    >
      {/* Timestamp */}
      <span
        className="text-[10px] text-text-muted tabular-nums shrink-0 mt-0.5 w-14"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {new Date(item.timestamp).toLocaleTimeString("en", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })}
      </span>

      {/* Level badge */}
      <span
        className={cn(
          "text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 mt-px",
          config.bgColor,
          config.color
        )}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {config.label}
      </span>

      {/* Message + Detail */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-1.5">
          {hasDetail && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-0.5 shrink-0 text-text-muted hover:text-text-primary transition-colors"
            >
              {expanded ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
            </button>
          )}
          <span
            className={cn(
              "text-[11px] leading-relaxed",
              item.type === "error" ? "text-danger" : "text-text-primary"
            )}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {item.message}
          </span>
        </div>

        {hasDetail && expanded && (
          <motion.pre
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mt-1.5 ml-4 text-[10px] text-text-muted leading-relaxed p-2 rounded bg-surface-overlay/60 overflow-x-auto whitespace-pre-wrap break-all"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {formatDetail(item.detail!)}
          </motion.pre>
        )}
      </div>

      {/* Relative time */}
      <span
        className="text-[9px] text-text-muted shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {timeAgo(item.timestamp)}
      </span>
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
  const [filters, setFilters] = useState<Set<LogLevel>>(
    new Set(["trade", "signal", "risk", "info", "error"])
  );
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
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center size-7 rounded-lg bg-neon/8">
            <Terminal className="size-3.5 text-neon" />
          </div>
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Live Logs
          </h3>
          <span
            className="text-[10px] text-text-muted tabular-nums"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {filteredItems.length} entries
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Pause/Resume */}
          <button
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
            {paused ? "RESUME" : "PAUSE"}
          </button>

          {/* Filter toggle */}
          <button
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
            FILTER
          </button>

          {/* Live indicator */}
          <div className="flex items-center gap-1.5 ml-1">
            <span className="relative flex size-2">
              <span
                className={cn(
                  "absolute inline-flex size-full rounded-full opacity-75",
                  paused ? "bg-warning" : "animate-ping bg-neon"
                )}
              />
              <span
                className={cn(
                  "relative inline-flex size-2 rounded-full",
                  paused ? "bg-warning" : "bg-neon"
                )}
              />
            </span>
            <span
              className={cn(
                "text-[10px] font-bold",
                paused ? "text-warning" : "text-neon"
              )}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {paused ? "PAUSED" : "LIVE"}
            </span>
          </div>
        </div>
      </div>

      {/* Filters bar */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-2 pb-3 border-b border-border-dim mb-2">
              {(Object.keys(LEVEL_CONFIG) as LogLevel[]).map((level) => {
                const cfg = LEVEL_CONFIG[level];
                const active = filters.has(level);
                const count = levelCounts[level] || 0;
                return (
                  <button
                    key={level}
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

      {/* Log entries */}
      <div
        ref={scrollRef}
        className="flex flex-col gap-px max-h-[480px] overflow-y-auto pr-1 scroll-smooth"
      >
        {filteredItems.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-text-muted">
            <span style={{ fontFamily: "var(--font-mono)" }}>
              No log entries matching filters
            </span>
          </div>
        ) : (
          filteredItems.map((item, i) => (
            <LogEntry key={item.id} item={item} index={i} />
          ))
        )}
      </div>

      {/* Bottom status bar */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border-dim">
        <div className="flex items-center gap-3">
          <span className="text-neon text-xs" style={{ fontFamily: "var(--font-mono)" }}>
            {">"}
          </span>
          <span
            className="text-[10px] text-text-muted"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {paused
              ? "Auto-scroll paused — new logs still arriving"
              : "Streaming agent logs..."}
          </span>
        </div>
        <div
          className="flex items-center gap-3 text-[9px] text-text-muted"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span>{levelCounts["trade"] || 0} trades</span>
          <span>{levelCounts["error"] || 0} errors</span>
          <span>{activity.length} total</span>
        </div>
      </div>
    </motion.div>
  );
}
