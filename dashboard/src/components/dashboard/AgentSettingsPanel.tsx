"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Settings2,
  Save,
  Loader2,
  Eye,
  EyeOff,
  Check,
  Shield,
  Scale,
  Rocket,
  SlidersHorizontal,
  Fuel,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CONFIG_ALLOWLIST, SECRET_CONFIG_KEYS } from "@/lib/config-allowlist";
import {
  SETTINGS_PRESET_VALUES,
  DEFAULT_PRESET_ID,
  detectPreset,
  msToMinutes,
  minutesToMs,
  msToSeconds,
  secondsToMs,
  confidenceToPercent,
  percentToConfidence,
  formatPresetSummary,
  EXECUTION_CONFIG_KEYS,
  type SettingsPresetId,
} from "@/lib/settings-presets";
import {
  AGENT_UNIVERSE_OPTIONS,
  resolveAgentUniverse,
  agentUniverseLabel,
} from "@/lib/agent-universe";
import {
  GAS_SPEED_PRESETS,
  detectGasSpeedPreset,
  gasSpeedEnv,
  estimatePresetCosts,
  formatGasUsd,
  formatRelativeCost,
  type GasSpeedPresetId,
} from "@/lib/gas-presets";

const PRESET_ICONS: Record<SettingsPresetId, LucideIcon> = {
  safe: Shield,
  balanced: Scale,
  aggressive: Rocket,
  custom: SlidersHorizontal,
};

const SETTINGS_PRESETS = SETTINGS_PRESET_VALUES.map((p) => ({
  ...p,
  icon: PRESET_ICONS[p.id],
}));

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] text-text-muted uppercase tracking-wide">
          {label}
        </span>
        {hint ? (
          <span className="text-[9px] text-text-muted/70 truncate">{hint}</span>
        ) : null}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

const selectCls =
  "w-full px-2.5 py-1.5 rounded-md bg-surface-overlay border border-border-dim text-sm text-text-primary outline-none focus:border-cyan/50 transition-colors";

const CUSTOM = "__custom__";

/** Preset select + free-form number when Custom is chosen (or value is not in the list). */
function SelectOrCustom({
  value,
  options,
  onChange,
  prefix = "",
  suffix = "",
  min,
  max,
  step = "1",
  placeholder = "Enter value",
}: {
  value: string;
  options: number[];
  onChange: (next: string) => void;
  prefix?: string;
  suffix?: string;
  min: number;
  max: number;
  step?: string;
  placeholder?: string;
}) {
  const opts = options.map(String);
  const [customMode, setCustomMode] = useState(() => !opts.includes(value));
  const isCustom = customMode || !opts.includes(value);

  return (
    <div className="flex gap-1.5">
      <select
        value={isCustom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustomMode(true);
            if (!value) onChange(String(min));
          } else {
            setCustomMode(false);
            onChange(e.target.value);
          }
        }}
        className={cn(selectCls, isCustom ? "w-[42%]" : "w-full")}
      >
        {options.map((n) => (
          <option key={n} value={String(n)}>
            {prefix}
            {n}
            {suffix}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {isCustom && (
        <div className="relative w-[58%]">
          {prefix ? (
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-text-muted">
              {prefix}
            </span>
          ) : null}
          <input
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            value={value}
            placeholder={placeholder}
            onChange={(e) => {
              setCustomMode(true);
              onChange(e.target.value);
            }}
            className={cn(
              selectCls,
              "w-full font-mono tabular-nums",
              prefix && "pl-5"
            )}
          />
        </div>
      )}
    </div>
  );
}

function TuningGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-dim/80 bg-void/40 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan/80 mb-2">
        {title}
      </p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">{children}</div>
    </div>
  );
}

interface AgentSettingsPanelProps {
  agentId: string;
  connected?: boolean;
  readOnly?: boolean;
}

type Draft = Record<string, string>;

function applyPresetToDraft(draft: Draft, presetId: SettingsPresetId): Draft {
  const preset = SETTINGS_PRESETS.find((p) => p.id === presetId);
  if (!preset?.values) return { ...draft };
  return { ...draft, ...preset.values };
}

export function AgentSettingsPanel({ agentId, connected, readOnly }: AgentSettingsPanelProps) {
  const [config, setConfig] = useState<Record<string, string | null>>({});
  const [draft, setDraft] = useState<Draft>({});
  const [preset, setPreset] = useState<SettingsPresetId>(DEFAULT_PRESET_ID);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);
  const [bnbUsd, setBnbUsd] = useState(576);

  useEffect(() => {
    fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT")
      .then((r) => r.json())
      .then((d: { price?: string }) => {
        const n = parseFloat(d.price ?? "");
        if (Number.isFinite(n) && n > 0) setBnbUsd(n);
      })
      .catch(() => {});
  }, []);

  const gasSpeed = useMemo(
    () => detectGasSpeedPreset(draft.BSC_GAS_PRICE_GWEI, draft.BSC_SWAP_GAS_LIMIT),
    [draft.BSC_GAS_PRICE_GWEI, draft.BSC_SWAP_GAS_LIMIT]
  );

  const selectGasSpeed = (id: GasSpeedPresetId) => {
    const env = gasSpeedEnv(id);
    setDraft((d) => ({
      ...d,
      BSC_GAS_PRICE_GWEI: env.BSC_GAS_PRICE_GWEI,
      BSC_SWAP_GAS_LIMIT: env.BSC_SWAP_GAS_LIMIT,
    }));
  };

  useEffect(() => {
    fetch(`/api/agents/${agentId}/config`)
      .then((r) => r.json())
      .then((d: { config?: Record<string, string | null> }) => {
        const cfg = d.config || {};
        setConfig(cfg);
        const next: Draft = Object.fromEntries(
          Object.entries(cfg).map(([k, v]) => [k, v ?? ""])
        );
        // Seed defaults so empty configs look like Balanced
        if (!next.STRATEGY) next.STRATEGY = "medium";
        if (!next.SLIPPAGE_TOLERANCE) next.SLIPPAGE_TOLERANCE = "1";
        if (!next.MIN_GAS_RESERVE_USD) next.MIN_GAS_RESERVE_USD = "1.5";
        if (!next.MIN_TRADE_AMOUNT_USD) next.MIN_TRADE_AMOUNT_USD = "5";
        if (!next.MAX_PORTFOLIO_TOKENS) next.MAX_PORTFOLIO_TOKENS = "3";
        if (!next.MIN_BUY_CONFIDENCE) next.MIN_BUY_CONFIDENCE = "0.55";
        if (!next.AUTO_EXIT_ENABLED) next.AUTO_EXIT_ENABLED = "true";
        if (!next.TRAILING_ACTIVATE_PCT) next.TRAILING_ACTIVATE_PCT = "6";
        if (!next.TRAILING_GIVEBACK_PCT) next.TRAILING_GIVEBACK_PCT = "3";
        if (!next.PROTECTIVE_EXIT_CHECK_MS) next.PROTECTIVE_EXIT_CHECK_MS = "60000";
        const gas = gasSpeedEnv(
          detectGasSpeedPreset(next.BSC_GAS_PRICE_GWEI, next.BSC_SWAP_GAS_LIMIT)
        );
        if (!next.BSC_GAS_PRICE_GWEI || next.BSC_GAS_PRICE_GWEI === "0") {
          next.BSC_GAS_PRICE_GWEI = gas.BSC_GAS_PRICE_GWEI;
        }
        // Gas limit is always auto (estimated per tx) — never keep a pinned ceiling
        next.BSC_SWAP_GAS_LIMIT = gas.BSC_SWAP_GAS_LIMIT;
        setDraft(next);
        setPreset(detectPreset(cfg));
      })
      .finally(() => setLoading(false));
  }, [agentId]);

  const selectPreset = (id: SettingsPresetId) => {
    setPreset(id);
    setMsg(null);
    if (id !== "custom") {
      setDraft((d) => applyPresetToDraft(d, id));
    }
  };

  const updateField = (key: string, value: string) => {
    setPreset("custom");
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const updateExecutionField = (key: string, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const toSave =
        preset === "custom" ? draft : applyPresetToDraft(draft, preset);

      const updates: Record<string, string> = {};
      for (const key of CONFIG_ALLOWLIST) {
        const val = toSave[key];
        if (val === undefined) continue;
        if (SECRET_CONFIG_KEYS.has(key) && (val === "••••••••" || val === "")) continue;
        if (val !== (config[key] ?? "")) updates[key] = val;
      }
      // Always persist STRATEGY when using a named preset
      if (preset !== "custom") {
        const p = SETTINGS_PRESETS.find((x) => x.id === preset);
        if (p?.values) {
          for (const [k, v] of Object.entries(p.values)) {
            if ((EXECUTION_CONFIG_KEYS as readonly string[]).includes(k)) continue;
            if (v !== (config[k] ?? "")) updates[k] = v;
          }
        }
      }

      if (Object.keys(updates).length === 0) {
        setMsg("Already up to date");
        return;
      }
      const res = await fetch(`/api/agents/${agentId}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      const saved = data.config || {};
      setConfig(saved);
      setDraft(
        Object.fromEntries(
          Object.entries(saved).map(([k, v]) => [k, (v as string | null) ?? ""])
        )
      );
      setPreset(detectPreset(saved));
      setMsg("Saved: applies on next cycle");
      if (data.reload?.reloaded === false && data.reload?.error) {
        setMsg(`Saved to disk · live reload: ${data.reload.error}`);
      } else if (data.reload?.reloaded) {
        setMsg("Saved: live reload OK, applies next cycle");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const activePreset = useMemo(
    () => SETTINGS_PRESETS.find((p) => p.id === preset)!,
    [preset]
  );

  if (readOnly) return null;

  const tradeMinutes = msToMinutes(draft.TRADE_INTERVAL_MS) || "60";
  const signalMinutes = msToMinutes(draft.SIGNAL_REFRESH_MS) || "5";
  const exitCheckSeconds = msToSeconds(draft.PROTECTIVE_EXIT_CHECK_MS);
  const buyConfidencePct = confidenceToPercent(draft.MIN_BUY_CONFIDENCE);
  const universe = resolveAgentUniverse(draft.AGENT_UNIVERSE);
  const universeMeta = AGENT_UNIVERSE_OPTIONS.find((o) => o.id === universe)!;

  return (
    <div className="glass-raised rounded-xl p-5">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Settings2 className="size-4 text-cyan" />
          <h3 className="text-sm font-semibold uppercase tracking-wide">
            Agent Settings
          </h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-text-muted font-mono">
            {connected ? "live · next cycle" : "saved · applies on start"}
          </span>
          <button
            type="button"
            onClick={() => setShowSecrets((s) => !s)}
            className="text-text-muted hover:text-cyan"
            title="Toggle secret visibility"
          >
            {showSecrets ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>
      <p className="text-[11px] text-text-muted mb-4">
        One place for strategy and risk. Pick Safe, Balanced, or Aggressive: or Custom to
        fine-tune.{" "}
        <span className="text-cyan">Balanced</span> is the default. Settings are saved to
        your agent and apply on the next trading cycle.
      </p>

      {loading ? (
        <Loader2 className="size-4 animate-spin text-neon" />
      ) : (
        <>
          <div className="mb-4 rounded-lg border border-border-dim/60 bg-surface-overlay/30 px-3 py-2.5">
            <p className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">
              Trading universe (set at deploy)
            </p>
            <p className="text-sm font-semibold text-text-primary">
              {agentUniverseLabel(universe)}
            </p>
            <p className="text-[11px] text-text-secondary mt-0.5">
              {universeMeta.tagline}: {universeMeta.detail}
            </p>
          </div>

          {/* Preset cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2 mb-5">
            {SETTINGS_PRESETS.map((opt) => {
              const Icon = opt.icon;
              const selected = preset === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => selectPreset(opt.id)}
                  className={cn(
                    "relative flex flex-col gap-1 text-left rounded-xl border px-3 py-3 transition-all",
                    selected
                      ? "bg-neon/10 border-neon/40 ring-1 ring-neon/20"
                      : "bg-surface-overlay/40 border-border-dim hover:border-cyan/30"
                  )}
                >
                  {opt.id === "balanced" && (
                    <span className="absolute top-2 right-2 text-[9px] font-bold uppercase tracking-wide text-neon bg-neon/15 px-1.5 py-0.5 rounded">
                      Default
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <Icon
                      className={cn(
                        "size-4",
                        selected ? "text-neon" : "text-text-muted"
                      )}
                    />
                    <span className="text-sm font-semibold text-text-primary">
                      {opt.label}
                    </span>
                    {selected && <Check className="size-3.5 text-neon ml-auto" />}
                  </div>
                  <span className="text-[11px] text-text-secondary">{opt.tagline}</span>
                  <span className="text-[10px] text-text-muted leading-snug">
                    {opt.detail}
                  </span>
                </button>
              );
            })}
          </div>

          {preset !== "custom" && activePreset.values && (
            <div className="mb-5 rounded-lg border border-border-dim/60 bg-surface-overlay/30 px-3 py-2.5">
              <p className="text-[11px] text-text-secondary font-mono">
                {formatPresetSummary(activePreset.values)}
              </p>
              <p className="text-[10px] text-text-muted mt-1.5">
                Need min trade size, auto-exit, buy confidence, or max tokens? Pick{" "}
                <button
                  type="button"
                  onClick={() => selectPreset("custom")}
                  className="text-cyan hover:underline"
                >
                  Custom
                </button>{" "}
                below.
              </p>
            </div>
          )}

          {/* Always-visible simple fields */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <label className="block">
              <span className="text-[10px] text-text-muted uppercase tracking-wide">
                Agent name
              </span>
              <input
                type="text"
                value={draft.AGENT_DISPLAY_NAME ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, AGENT_DISPLAY_NAME: e.target.value }))
                }
                placeholder="My trading agent"
                className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-overlay border border-border-dim text-sm text-text-primary outline-none focus:border-neon/40"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-text-muted uppercase tracking-wide">
                AI helper key (optional)
              </span>
              <input
                type={showSecrets ? "text" : "password"}
                value={draft.OPENAI_API_KEY ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, OPENAI_API_KEY: e.target.value }))
                }
                placeholder="Leave blank to skip"
                className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-overlay border border-border-dim text-sm font-mono text-text-primary outline-none focus:border-neon/40"
              />
            </label>
          </div>

          {/* BNB Chain execution: compact */}
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Fuel className="size-3.5 text-amber-400" />
              <p className="text-xs font-semibold text-amber-400">BNB Chain execution</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
              <label className="block sm:col-span-1">
                <span className="text-[10px] text-text-muted uppercase">Slippage</span>
                <select
                  value={draft.SLIPPAGE_TOLERANCE || "1"}
                  onChange={(e) =>
                    updateExecutionField("SLIPPAGE_TOLERANCE", e.target.value)
                  }
                  className="mt-1 w-full px-2 py-1.5 rounded-md bg-surface-overlay border border-border-dim text-sm text-text-primary outline-none focus:border-amber-400/40"
                >
                  {["0.5", "1", "1.5", "2", "3", "5"].map((n) => (
                    <option key={n} value={n}>
                      {n}%
                    </option>
                  ))}
                </select>
              </label>

              <label className="block sm:col-span-1">
                <span className="text-[10px] text-text-muted uppercase">BNB reserve</span>
                <select
                  value={draft.MIN_GAS_RESERVE_USD || "1.5"}
                  onChange={(e) =>
                    updateExecutionField("MIN_GAS_RESERVE_USD", e.target.value)
                  }
                  className="mt-1 w-full px-2 py-1.5 rounded-md bg-surface-overlay border border-border-dim text-sm text-text-primary outline-none focus:border-amber-400/40"
                >
                  {["0.5", "1", "1.5", "2", "2.5", "5"].map((n) => (
                    <option key={n} value={n}>
                      ${n}
                    </option>
                  ))}
                </select>
              </label>

              <div className="col-span-2 sm:col-span-3 grid grid-cols-3 gap-1.5">
                {GAS_SPEED_PRESETS.map((gp) => {
                  const est = estimatePresetCosts(gp, bnbUsd);
                  const selected = gasSpeed === gp.id;
                  return (
                    <button
                      key={gp.id}
                      type="button"
                      disabled={readOnly}
                      onClick={() => selectGasSpeed(gp.id)}
                      className={cn(
                        "text-left rounded-md border px-2 py-1.5 transition-colors",
                        selected
                          ? "border-amber-400/60 bg-amber-500/15"
                          : "border-border-dim bg-surface-overlay hover:border-amber-400/30",
                        readOnly && "opacity-60 cursor-not-allowed"
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-1">
                        <span className="text-xs font-semibold text-text-primary">
                          {gp.label}
                        </span>
                        <span className="text-[9px] font-mono text-text-muted">
                          {gp.gwei} gwei
                        </span>
                      </div>
                      <p className="text-[11px] text-amber-200/90 mt-0.5">
                        ~{formatGasUsd(est.swapUsd)}/swap
                      </p>
                      <p className="text-[9px] text-text-muted">
                        {formatRelativeCost(est.relativeToNormal)}
                      </p>
                    </button>
                  );
                })}
              </div>
              <p className="col-span-2 sm:col-span-3 text-[9px] text-text-muted">
                Gas limit is always auto (estimated per tx). You only pick gwei.
              </p>
            </div>
          </div>

          {/* Custom advanced controls */}
          {preset === "custom" && (
            <div className="mb-4 space-y-2">
              <div className="flex items-end justify-between gap-3 px-0.5">
                <div>
                  <p className="text-xs font-semibold text-cyan">Custom tuning</p>
                  <p className="text-[10px] text-text-muted">
                    Grouped by how the agent decides, protects, and sizes trades.
                  </p>
                </div>
                <p className="hidden sm:block text-[10px] font-mono text-text-muted">
                  {draft.STRATEGY || "medium"} · {tradeMinutes}m cycle · −
                  {draft.STOP_LOSS_PCT || "8"}% / +{draft.TAKE_PROFIT_PCT || "15"}%
                </p>
              </div>

              <TuningGroup title="Strategy & cadence">
                <Field label="Engine">
                  <select
                    value={draft.STRATEGY || "medium"}
                    onChange={(e) => updateField("STRATEGY", e.target.value)}
                    className={selectCls}
                  >
                    <option value="safe">SafeTrade</option>
                    <option value="medium">Medium</option>
                    <option value="momentum">Momentum</option>
                    <option value="bstocks">Equity Trend</option>
                  </select>
                </Field>
                <Field label="Trade every" hint="cycle">
                  <select
                    value={tradeMinutes}
                    onChange={(e) =>
                      updateField("TRADE_INTERVAL_MS", minutesToMs(e.target.value))
                    }
                    className={selectCls}
                  >
                    <option value="15">15 min</option>
                    <option value="30">30 min</option>
                    <option value="60">1 hour</option>
                    <option value="120">2 hours</option>
                    <option value="240">4 hours</option>
                  </select>
                </Field>
                <Field label="Scan every" hint="signals">
                  <select
                    value={signalMinutes}
                    onChange={(e) =>
                      updateField("SIGNAL_REFRESH_MS", minutesToMs(e.target.value))
                    }
                    className={selectCls}
                  >
                    <option value="1">1 min</option>
                    <option value="3">3 min</option>
                    <option value="5">5 min</option>
                    <option value="15">15 min</option>
                  </select>
                </Field>
                <Field label="Max / day">
                  <select
                    value={draft.MAX_DAILY_TRADES || "5"}
                    onChange={(e) => updateField("MAX_DAILY_TRADES", e.target.value)}
                    className={selectCls}
                  >
                    {[2, 3, 5, 8, 10].map((n) => (
                      <option key={n} value={String(n)}>
                        {n} trades
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Buy confidence" className="col-span-2 lg:col-span-2">
                  <select
                    value={buyConfidencePct}
                    onChange={(e) =>
                      updateField(
                        "MIN_BUY_CONFIDENCE",
                        percentToConfidence(e.target.value)
                      )
                    }
                    className={selectCls}
                  >
                    <option value="70">70% · very selective</option>
                    <option value="65">65% · conservative</option>
                    <option value="55">55% · balanced</option>
                    <option value="45">45% · aggressive</option>
                    <option value="40">40% · opportunistic</option>
                  </select>
                </Field>
              </TuningGroup>

              <TuningGroup title="Risk & exits">
                <Field label="Stop loss">
                  <select
                    value={draft.STOP_LOSS_PCT || "8"}
                    onChange={(e) => updateField("STOP_LOSS_PCT", e.target.value)}
                    className={selectCls}
                  >
                    {[3, 5, 8, 10, 15].map((n) => (
                      <option key={n} value={String(n)}>
                        −{n}%
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Take profit">
                  <select
                    value={draft.TAKE_PROFIT_PCT || "15"}
                    onChange={(e) => updateField("TAKE_PROFIT_PCT", e.target.value)}
                    className={selectCls}
                  >
                    {[8, 10, 15, 20, 28, 40].map((n) => (
                      <option key={n} value={String(n)}>
                        +{n}%
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Max drawdown">
                  <select
                    value={draft.MAX_DRAWDOWN_PCT || "20"}
                    onChange={(e) => updateField("MAX_DRAWDOWN_PCT", e.target.value)}
                    className={selectCls}
                  >
                    {[10, 12, 15, 20, 25, 30].map((n) => (
                      <option key={n} value={String(n)}>
                        {n}%
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Drawdown pause">
                  <select
                    value={draft.DISABLE_DRAWDOWN_LIMIT === "true" ? "false" : "true"}
                    onChange={(e) =>
                      updateField(
                        "DISABLE_DRAWDOWN_LIMIT",
                        e.target.value === "true" ? "false" : "true"
                      )
                    }
                    className={selectCls}
                  >
                    <option value="true">On</option>
                    <option value="false">Off</option>
                  </select>
                </Field>
                <Field label="Auto exit">
                  <select
                    value={draft.AUTO_EXIT_ENABLED === "false" ? "false" : "true"}
                    onChange={(e) => updateField("AUTO_EXIT_ENABLED", e.target.value)}
                    className={selectCls}
                  >
                    <option value="true">On · SL/TP/trail</option>
                    <option value="false">Off · manual</option>
                  </select>
                </Field>
                <Field label="Trail activates">
                  <select
                    value={draft.TRAILING_ACTIVATE_PCT || "6"}
                    onChange={(e) =>
                      updateField("TRAILING_ACTIVATE_PCT", e.target.value)
                    }
                    className={selectCls}
                  >
                    {[4, 5, 6, 8, 10, 12, 15].map((n) => (
                      <option key={n} value={String(n)}>
                        +{n}% gain
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Trail giveback">
                  <select
                    value={draft.TRAILING_GIVEBACK_PCT || "3"}
                    onChange={(e) =>
                      updateField("TRAILING_GIVEBACK_PCT", e.target.value)
                    }
                    className={selectCls}
                  >
                    {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                      <option key={n} value={String(n)}>
                        {n}% from peak
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Exit check">
                  <select
                    value={exitCheckSeconds}
                    onChange={(e) =>
                      updateField(
                        "PROTECTIVE_EXIT_CHECK_MS",
                        secondsToMs(e.target.value)
                      )
                    }
                    className={selectCls}
                  >
                    <option value="30">30 sec</option>
                    <option value="60">60 sec</option>
                    <option value="120">2 min</option>
                    <option value="300">5 min</option>
                  </select>
                </Field>
              </TuningGroup>

              <TuningGroup title="Position size">
                <Field label="Max per trade" hint="$">
                  <SelectOrCustom
                    value={draft.MAX_POSITION_SIZE_USD || "100"}
                    options={[25, 50, 100, 150, 200, 500]}
                    onChange={(v) => updateField("MAX_POSITION_SIZE_USD", v)}
                    prefix="$"
                    min={1}
                    max={1_000_000}
                    step="1"
                    placeholder="e.g. 75"
                  />
                </Field>
                <Field label="Min per trade" hint="$">
                  <SelectOrCustom
                    value={draft.MIN_TRADE_AMOUNT_USD || "5"}
                    options={[1, 3, 5, 10, 15, 25, 50]}
                    onChange={(v) => updateField("MIN_TRADE_AMOUNT_USD", v)}
                    prefix="$"
                    min={0.5}
                    max={100_000}
                    step="0.5"
                    placeholder="e.g. 7.5"
                  />
                </Field>
                <Field label="Max tokens held">
                  <SelectOrCustom
                    value={draft.MAX_PORTFOLIO_TOKENS || "3"}
                    options={[1, 2, 3, 4, 5, 6, 8]}
                    onChange={(v) => updateField("MAX_PORTFOLIO_TOKENS", v)}
                    min={1}
                    max={50}
                    step="1"
                    placeholder="e.g. 7"
                  />
                </Field>
              </TuningGroup>
            </div>
          )}
        </>
      )}

      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || loading}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-xs font-semibold bg-neon/15 text-neon border border-neon/30 hover:bg-neon/25 disabled:opacity-40"
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          Save {preset === "custom" ? "custom" : activePreset.label.toLowerCase()} settings
        </button>
        {msg && (
          <span className="text-[11px] font-mono text-text-secondary">{msg}</span>
        )}
      </div>
    </div>
  );
}
