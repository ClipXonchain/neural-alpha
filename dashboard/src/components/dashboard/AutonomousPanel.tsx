"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/lib/mock-data";

function formatPulseAge(ageSec: number | null, scanning: boolean): string {
  if (scanning) return "pulsing…";
  if (ageSec === null) return "starting…";
  if (ageSec <= 1) return "live";
  if (ageSec < 60) return `${ageSec}s ago`;
  return `${Math.floor(ageSec / 60)}m ago`;
}

function useAgeSec(atMs: number | null | undefined): number | null {
  const [ageSec, setAgeSec] = useState<number | null>(() =>
    atMs ? Math.max(0, Math.floor((Date.now() - atMs) / 1000)) : null
  );
  useEffect(() => {
    if (!atMs) {
      setAgeSec(null);
      return;
    }
    const tick = () => setAgeSec(Math.max(0, Math.floor((Date.now() - atMs) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [atMs]);
  return ageSec;
}

export function AutonomousPanel({ state }: { state: AgentState }) {
  const auto = state.autonomous;
  const running = state.status === "running";
  const scanning = auto.phase === "scanning";
  const pulseAgeSec = useAgeSec(running ? state.lastSignalRefreshAt : null);
  const stale =
    running &&
    pulseAgeSec !== null &&
    pulseAgeSec > Math.max(20, (state.signalRefreshSec ?? 10) * 3);

  return (
    <div className="glass-raised rounded-xl px-3 sm:px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-mono min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={cn(
            "size-1.5 rounded-full",
            scanning && "bg-cyan animate-pulse",
            auto.phase === "blocked" && "bg-danger",
            auto.phase === "stopped" && "bg-text-muted",
            auto.phase === "idle" && !stale && "bg-neon animate-pulse",
            auto.phase === "idle" && stale && "bg-warning"
          )}
        />
        <span className="text-text-primary truncate">{auto.headline}</span>
      </div>
      <span className="text-text-muted">
        24/7 · NY {auto.nyTimeLabel}
        {auto.session === "rth" ? " · cash open" : " · cash closed"}
      </span>
      <span
        className={cn(
          "flex items-center gap-1",
          stale ? "text-warning" : "text-cyan"
        )}
      >
        <Radio className="size-3" />
        {formatPulseAge(pulseAgeSec, scanning)}
      </span>
      <span className="text-text-muted">{auto.tradesLast24h} trades / 24h</span>
      <span className="text-text-muted">
        {auto.autoExitEnabled
          ? `SL ${state.stopLossPct ?? 8}% · TP ${state.takeProfitPct ?? 14}%`
          : "exits off"}
      </span>
      {auto.blockReason && auto.phase !== "idle" && (
        <span className="flex items-center gap-1 text-warning">
          <AlertTriangle className="size-3" />
          {auto.blockReason}
        </span>
      )}
      {auto.failedSwapCooldowns.length > 0 && (
        <span className="text-text-muted">
          cooldown {auto.failedSwapCooldowns.map((c) => `${c.symbol} ${c.remainingMin}m`).join(", ")}
        </span>
      )}
    </div>
  );
}
