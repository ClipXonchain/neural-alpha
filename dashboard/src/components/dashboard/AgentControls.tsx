"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Save, Check, AlertTriangle, RotateCcw, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DeskConfig {
  mode: string;
  maxPositionSizeUsd: number;
  slippageTolerance: number;
  minGasReserveUsd: number;
  maxPortfolioTokens: number;
  baseCurrency: string;
  swapCurrencies?: string[];
  stopLossPct?: number;
  takeProfitPct?: number;
}

function snap(value: number, step: number): number {
  const decimals = step < 1 ? (String(step).split(".")[1]?.length ?? 1) : 0;
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

function clamp(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  return snap(Math.min(max, Math.max(min, value)), step);
}

function SettingField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  unit,
  presets,
  accent,
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
  presets?: number[];
  accent?: "danger" | "neon" | "cyan" | "warning";
}) {
  const accentClass =
    accent === "danger"
      ? "focus-within:border-danger/50"
      : accent === "neon"
        ? "focus-within:border-neon/50"
        : accent === "warning"
          ? "focus-within:border-warning/50"
          : "focus-within:border-cyan/50";

  const unitClass =
    accent === "danger"
      ? "text-danger/80"
      : accent === "neon"
        ? "text-neon/80"
        : "text-text-muted";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-[10px] uppercase tracking-[0.14em] text-text-muted">
          {label}
        </label>
        <span className="text-[10px] text-text-muted tabular-nums">{hint}</span>
      </div>
      <div
        className={cn(
          "flex items-center gap-1 rounded-lg border border-border-dim bg-void/60 px-1",
          accentClass,
          disabled && "opacity-40"
        )}
      >
        <button
          type="button"
          disabled={disabled || value <= min}
          onClick={() => onChange(clamp(value - step, min, max, step))}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-overlay hover:text-text-primary disabled:opacity-30"
          aria-label={`Decrease ${label}`}
        >
          <Minus className="size-3.5" />
        </button>
        <div className="relative min-w-0 flex-1">
          <input
            type="number"
            value={value}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n)) onChange(n);
            }}
            onBlur={() => onChange(clamp(value, min, max, step))}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            className={cn(
              "w-full bg-transparent py-2 text-center text-[16px] font-semibold text-text-primary tabular-nums",
              "focus:outline-none disabled:opacity-30",
              unit ? "pr-8" : ""
            )}
            style={{ fontFamily: "var(--font-mono)" }}
          />
          {unit && (
            <span
              className={cn(
                "pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-[10px] font-medium",
                unitClass
              )}
            >
              {unit}
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={disabled || value >= max}
          onClick={() => onChange(clamp(value + step, min, max, step))}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-overlay hover:text-text-primary disabled:opacity-30"
          aria-label={`Increase ${label}`}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {presets && presets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              disabled={disabled}
              onClick={() => onChange(p)}
              className={cn(
                "rounded-md px-2 py-0.5 text-[10px] tabular-nums border transition-colors",
                value === p
                  ? "border-cyan/40 bg-cyan/10 text-cyan"
                  : "border-transparent bg-surface-overlay text-text-muted hover:text-text-secondary"
              )}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {unit === "%" ? `${p}%` : unit === "USD" ? `$${p}` : p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface AgentControlsProps {
  connected: boolean;
  config: DeskConfig | null;
  onSave: (updates: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
}

export function AgentControls({ connected, config, onSave }: AgentControlsProps) {
  const [maxPos, setMaxPos] = useState(250);
  const [slippage, setSlippage] = useState(1);
  const [gasReserve, setGasReserve] = useState(1.5);
  const [maxPositions, setMaxPositions] = useState(4);
  const [stopLoss, setStopLoss] = useState(8);
  const [takeProfit, setTakeProfit] = useState(14);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [dirty, setDirty] = useState(false);

  const applyConfig = useCallback((next: DeskConfig) => {
    setMaxPos(next.maxPositionSizeUsd);
    setSlippage(next.slippageTolerance);
    setGasReserve(next.minGasReserveUsd);
    setMaxPositions(next.maxPortfolioTokens);
    if (next.stopLossPct != null) setStopLoss(next.stopLossPct);
    if (next.takeProfitPct != null) setTakeProfit(next.takeProfitPct);
  }, []);

  useEffect(() => {
    if (config && !dirty) applyConfig(config);
  }, [config, dirty, applyConfig]);

  const markDirty = useCallback((setter: (v: number) => void) => {
    return (v: number) => {
      setter(v);
      setDirty(true);
      setMessage(null);
    };
  }, []);

  const rewardRisk = useMemo(
    () => (stopLoss > 0 ? takeProfit / stopLoss : 0),
    [stopLoss, takeProfit]
  );

  const slShare = useMemo(() => {
    const span = stopLoss + takeProfit;
    return span > 0 ? (stopLoss / span) * 100 : 50;
  }, [stopLoss, takeProfit]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await onSave({
        maxPositionSizeUsd: clamp(maxPos, 5, 10000, 5),
        maxPortfolioTokens: clamp(maxPositions, 1, 20, 1),
        slippageTolerance: clamp(slippage, 0.1, 10, 0.1),
        minGasReserveUsd: clamp(gasReserve, 0.5, 50, 0.5),
        stopLossPct: clamp(stopLoss, 1, 40, 0.5),
        takeProfitPct: clamp(takeProfit, 1, 80, 0.5),
        autoExitEnabled: true,
        trailingActivatePct: 0,
        trailingGivebackPct: 0,
      });
      if (result.ok) {
        setMessage({ text: "Live — applies on next check", ok: true });
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

  const quote = (config?.swapCurrencies || ["USDT"]).join("/");

  return (
    <div className="glass-raised rounded-xl p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Trade settings
          </h3>
          <p className="mt-0.5 text-[11px] text-text-muted">
            Size, count, slippage, gas, stop and take-profit. Applies immediately.
          </p>
        </div>
        <span
          className="shrink-0 rounded-md border border-border-dim bg-void/50 px-2 py-0.5 text-[10px] text-text-muted"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {(config?.mode || "paper").toUpperCase()} · {quote}
        </span>
      </div>

      <div className="mb-4 rounded-lg border border-border-dim bg-void/40 px-3 py-2 text-[11px] text-text-secondary tabular-nums">
        Each buy ≤ ${maxPos} · up to {maxPositions} names · cut −{stopLoss}% · take +{takeProfit}%
      </div>

      <section className="mb-4">
        <p className="mb-2 text-[10px] uppercase tracking-[0.16em] text-text-muted">Position</p>
        <div className="grid grid-cols-2 gap-3">
          <SettingField
            label="Max size"
            hint="per name"
            value={maxPos}
            onChange={markDirty(setMaxPos)}
            min={5}
            max={10000}
            step={5}
            disabled={!connected}
            unit="USD"
            presets={[50, 100, 250]}
            accent="cyan"
          />
          <SettingField
            label="Max names"
            hint="open at once"
            value={maxPositions}
            onChange={markDirty(setMaxPositions)}
            min={1}
            max={20}
            step={1}
            disabled={!connected}
            presets={[2, 3, 4, 6]}
          />
        </div>
      </section>

      <section className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-[0.16em] text-text-muted">Exits</p>
          <span
            className={cn(
              "text-[10px] tabular-nums font-medium",
              rewardRisk >= 1.5 ? "text-neon" : rewardRisk >= 1 ? "text-warning" : "text-danger"
            )}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {rewardRisk.toFixed(1)}R
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SettingField
            label="Stop-loss"
            hint="cut loser"
            value={stopLoss}
            onChange={markDirty(setStopLoss)}
            min={1}
            max={40}
            step={0.5}
            disabled={!connected}
            unit="%"
            presets={[5, 8, 12]}
            accent="danger"
          />
          <SettingField
            label="Take-profit"
            hint="lock gain"
            value={takeProfit}
            onChange={markDirty(setTakeProfit)}
            min={1}
            max={80}
            step={0.5}
            disabled={!connected}
            unit="%"
            presets={[10, 14, 20]}
            accent="neon"
          />
        </div>
        <div className="mt-3">
          <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-overlay">
            <div className="absolute inset-y-0 left-0 bg-danger/45" style={{ width: `${slShare}%` }} />
            <div className="absolute inset-y-0 right-0 bg-neon/40" style={{ width: `${100 - slShare}%` }} />
            <div
              className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-text-primary bg-text-primary"
              style={{ left: `${slShare}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[9px] uppercase tracking-wide text-text-muted">
            <span className="text-danger/80">−{stopLoss}%</span>
            <span>entry</span>
            <span className="text-neon/80">+{takeProfit}%</span>
          </div>
        </div>
      </section>

      <section className="mb-4">
        <p className="mb-2 text-[10px] uppercase tracking-[0.16em] text-text-muted">Execution</p>
        <div className="grid grid-cols-2 gap-3">
          <SettingField
            label="Slippage"
            hint="swap tolerance"
            value={slippage}
            onChange={markDirty(setSlippage)}
            min={0.1}
            max={10}
            step={0.1}
            disabled={!connected}
            unit="%"
            presets={[0.5, 1, 2]}
            accent="warning"
          />
          <SettingField
            label="Gas reserve"
            hint="keep in BNB"
            value={gasReserve}
            onChange={markDirty(setGasReserve)}
            min={0.5}
            max={50}
            step={0.5}
            disabled={!connected}
            unit="USD"
            presets={[1, 1.5, 3]}
          />
        </div>
      </section>

      <div className="flex items-center gap-3 border-t border-border-dim pt-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={!connected || saving || !dirty}
          className={cn(
            "flex items-center gap-2 rounded-lg px-4 py-2 text-[11px] font-semibold border transition-colors",
            dirty
              ? "border-neon/40 bg-neon/10 text-neon hover:bg-neon/15"
              : "border-border-dim text-text-muted cursor-not-allowed"
          )}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {saving ? <RotateCcw className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          {saving ? "SAVING" : "APPLY"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              if (config) applyConfig(config);
              setDirty(false);
              setMessage(null);
            }}
            className="text-[11px] text-text-muted hover:text-text-secondary"
          >
            Reset
          </button>
        )}
        {message && (
          <span className={cn("flex items-center gap-1.5 text-[11px]", message.ok ? "text-neon" : "text-danger")}>
            {message.ok ? <Check className="size-3" /> : <AlertTriangle className="size-3" />}
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
