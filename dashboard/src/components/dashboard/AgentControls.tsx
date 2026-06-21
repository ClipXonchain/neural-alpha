"use client";

import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Settings2,
  Save,
  Check,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface AgentConfig {
  mode: string;
  maxPositionSizeUsd: number;
  tradeIntervalMs: number;
  maxDrawdownPct: number;
  slippageTolerance: number;
  maxDailyTrades: number;
  maxPortfolioTokens: number;
  baseCurrency: string;
}

interface AgentControlsProps {
  connected: boolean;
  config: AgentConfig | null;
  onSave: (updates: Partial<AgentConfig>) => Promise<{ ok: boolean; error?: string }>;
}

function ControlInput({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  unit,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  unit?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label
        className="text-[11px] text-text-secondary font-medium"
        style={{ fontFamily: "var(--font-body)" }}
      >
        {label}
      </label>
      <div className="relative">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          className={cn(
            "w-full bg-surface border border-border-dim rounded-lg px-4 py-3",
            "text-[15px] font-semibold text-text-primary tabular-nums",
            "focus:outline-none focus:border-neon/50 focus:ring-1 focus:ring-neon/10",
            "hover:border-border-glow transition-all duration-150",
            "disabled:opacity-30 disabled:cursor-not-allowed",
            "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          )}
          style={{ fontFamily: "var(--font-mono)" }}
        />
        {unit && (
          <span
            className="absolute right-4 top-1/2 -translate-y-1/2 text-[11px] text-text-muted font-medium"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {unit}
          </span>
        )}
      </div>
      <span className="text-[10px] text-text-muted leading-tight">
        {hint}
      </span>
    </div>
  );
}

function ReadonlyField({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string;
  hint: string;
  color?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[11px] text-text-secondary font-medium">
        {label}
      </label>
      <div
        className={cn("text-[15px] font-bold py-3", color || "text-text-primary")}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {value}
      </div>
      <span className="text-[10px] text-text-muted leading-tight">
        {hint}
      </span>
    </div>
  );
}

export function AgentControls({ connected, config, onSave }: AgentControlsProps) {
  const [maxPos, setMaxPos] = useState(100);
  const [interval, setInterval_] = useState(5);
  const [drawdown, setDrawdown] = useState(25);
  const [slippage, setSlippage] = useState(1.5);
  const [maxDaily, setMaxDaily] = useState(10);
  const [maxPositions, setMaxPositions] = useState(5);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (config && !dirty) {
      setMaxPos(config.maxPositionSizeUsd);
      setInterval_(config.tradeIntervalMs / 60000);
      setDrawdown(config.maxDrawdownPct);
      setSlippage(config.slippageTolerance);
      setMaxDaily(config.maxDailyTrades);
      setMaxPositions(config.maxPortfolioTokens);
    }
  }, [config, dirty]);

  const markDirty = useCallback((setter: (v: number) => void) => {
    return (v: number) => {
      setter(v);
      setDirty(true);
      setMessage(null);
    };
  }, []);

  const handleSave = async () => {
    if (drawdown > 30) {
      setMessage({ text: "Drawdown > 30% will DQ you!", ok: false });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await onSave({
        maxPositionSizeUsd: maxPos,
        tradeIntervalMs: interval * 60000,
        maxDrawdownPct: drawdown,
        slippageTolerance: slippage,
        maxDailyTrades: maxDaily,
        maxPortfolioTokens: maxPositions,
      });
      if (result.ok) {
        setMessage({ text: "Saved — applied next cycle", ok: true });
        setDirty(false);
      } else {
        setMessage({ text: result.error || "Failed to save", ok: false });
      }
    } catch (e) {
      setMessage({ text: String(e), ok: false });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDirty(false);
    setMessage(null);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.5 }}
      className="glass-raised rounded-xl p-5"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center size-7 rounded-lg bg-cyan/8">
            <Settings2 className="size-3.5 text-cyan" />
          </div>
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Agent Controls
          </h3>
        </div>
        <span
          className="text-[10px] text-text-muted font-medium"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          changes apply next cycle
        </span>
      </div>

      {/* Controls Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 mb-4">
        <ReadonlyField
          label="Mode"
          value={config?.mode?.toUpperCase() || "PAPER"}
          hint="Set via AGENT_MODE env"
        />
        <ControlInput
          label="Max Position ($)"
          hint="Max USD per single trade"
          value={maxPos}
          onChange={markDirty(setMaxPos)}
          min={5}
          max={10000}
          step={5}
          disabled={!connected}
          unit="USD"
        />
        <ControlInput
          label="Trade Interval"
          hint="Minutes between cycles"
          value={interval}
          onChange={markDirty(setInterval_)}
          min={0.5}
          max={60}
          step={0.5}
          disabled={!connected}
          unit="min"
        />
        <ControlInput
          label="Max Drawdown"
          hint="DQ at 30% — keep ≤ 25"
          value={drawdown}
          onChange={markDirty(setDrawdown)}
          min={5}
          max={30}
          step={1}
          disabled={!connected}
          unit="%"
        />
        <ControlInput
          label="Slippage"
          hint="Max slippage per swap"
          value={slippage}
          onChange={markDirty(setSlippage)}
          min={0.1}
          max={10}
          step={0.1}
          disabled={!connected}
          unit="%"
        />
        <ControlInput
          label="Max Daily Trades"
          hint="Trades per day cap"
          value={maxDaily}
          onChange={markDirty(setMaxDaily)}
          min={1}
          max={50}
          step={1}
          disabled={!connected}
        />
        <ControlInput
          label="Max Positions"
          hint="Concurrent token positions"
          value={maxPositions}
          onChange={markDirty(setMaxPositions)}
          min={1}
          max={20}
          step={1}
          disabled={!connected}
        />
        <ReadonlyField
          label="Base Currency"
          value={config?.baseCurrency || "USDT"}
          hint="Quote asset for trades"
        />
        <ReadonlyField
          label="Emergency Mode"
          value={config ? "OFF" : "—"}
          hint="Triggers at 80% of drawdown"
          color="text-neon"
        />
      </div>

      {/* Save bar */}
      <div className="flex items-center gap-3 pt-4 border-t border-border-dim">
        <button
          onClick={handleSave}
          disabled={!connected || saving || !dirty}
          className={cn(
            "flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-semibold transition-all",
            dirty
              ? "bg-neon/15 text-neon border border-neon/25 hover:bg-neon/25"
              : "bg-surface-overlay text-text-muted border border-border-dim cursor-not-allowed"
          )}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {saving ? (
            <RotateCcw className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          {saving ? "SAVING..." : "SAVE CONFIG"}
        </button>

        {dirty && (
          <button
            onClick={handleReset}
            className="text-[11px] text-text-muted hover:text-text-secondary transition-colors px-2 py-1"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Reset
          </button>
        )}

        {message && (
          <span
            className={cn(
              "flex items-center gap-1.5 text-[11px] font-medium",
              message.ok ? "text-neon" : "text-danger"
            )}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {message.ok ? (
              <Check className="size-3" />
            ) : (
              <AlertTriangle className="size-3" />
            )}
            {message.text}
          </span>
        )}
      </div>
    </motion.div>
  );
}
