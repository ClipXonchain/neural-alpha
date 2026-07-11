/** Shared preset values: safe to import from server or client. */

export type SettingsPresetId = "safe" | "balanced" | "aggressive" | "custom";

export type PresetConfig = Record<string, string>;

export interface SettingsPresetValues {
  id: SettingsPresetId;
  label: string;
  tagline: string;
  detail: string;
  strategy?: "safe" | "medium" | "momentum";
  values?: PresetConfig;
}

export const SETTINGS_PRESET_VALUES: SettingsPresetValues[] = [
  {
    id: "safe",
    label: "Safe",
    tagline: "Protect capital first",
    detail: "Fewer trades · tight stops · smaller positions",
    strategy: "safe",
    values: {
      STRATEGY: "safe",
      MAX_DRAWDOWN_PCT: "12",
      MAX_DAILY_TRADES: "3",
      MAX_PORTFOLIO_TOKENS: "3",
      STOP_LOSS_PCT: "5",
      TAKE_PROFIT_PCT: "10",
      TRADE_INTERVAL_MS: "3600000",
      SIGNAL_REFRESH_MS: "300000",
      SLIPPAGE_TOLERANCE: "1",
      MIN_GAS_RESERVE_USD: "2.5",
      MAX_POSITION_SIZE_USD: "50",
      MIN_BUY_CONFIDENCE: "0.65",
      MIN_TRADE_AMOUNT_USD: "5",
      TRAILING_ACTIVATE_PCT: "4",
      TRAILING_GIVEBACK_PCT: "2",
      PROTECTIVE_EXIT_CHECK_MS: "60000",
      AUTO_EXIT_ENABLED: "true",
    },
  },
  {
    id: "balanced",
    label: "Balanced",
    tagline: "Recommended default",
    detail: "Steady mix of risk and return: best for most people",
    strategy: "medium",
    values: {
      STRATEGY: "medium",
      MAX_DRAWDOWN_PCT: "20",
      MAX_DAILY_TRADES: "5",
      MAX_PORTFOLIO_TOKENS: "3",
      STOP_LOSS_PCT: "8",
      TAKE_PROFIT_PCT: "15",
      TRADE_INTERVAL_MS: "3600000",
      SIGNAL_REFRESH_MS: "300000",
      SLIPPAGE_TOLERANCE: "1",
      MIN_GAS_RESERVE_USD: "1.5",
      BSC_GAS_PRICE_GWEI: "0.07",
      BSC_SWAP_GAS_LIMIT: "0",
      MAX_POSITION_SIZE_USD: "100",
      MIN_BUY_CONFIDENCE: "0.55",
      MIN_TRADE_AMOUNT_USD: "5",
      TRAILING_ACTIVATE_PCT: "6",
      TRAILING_GIVEBACK_PCT: "3",
      PROTECTIVE_EXIT_CHECK_MS: "60000",
      AUTO_EXIT_ENABLED: "true",
    },
  },
  {
    id: "aggressive",
    label: "Aggressive",
    tagline: "Chase bigger moves",
    detail: "More trades · wider stops · higher upside and risk",
    strategy: "momentum",
    values: {
      STRATEGY: "momentum",
      MAX_DRAWDOWN_PCT: "28",
      MAX_DAILY_TRADES: "6",
      MAX_PORTFOLIO_TOKENS: "4",
      STOP_LOSS_PCT: "10",
      TAKE_PROFIT_PCT: "28",
      TRADE_INTERVAL_MS: "1800000",
      SIGNAL_REFRESH_MS: "180000",
      SLIPPAGE_TOLERANCE: "1.5",
      MIN_GAS_RESERVE_USD: "1",
      MAX_POSITION_SIZE_USD: "150",
      MIN_BUY_CONFIDENCE: "0.45",
      MIN_TRADE_AMOUNT_USD: "5",
      TRAILING_ACTIVATE_PCT: "8",
      TRAILING_GIVEBACK_PCT: "4",
      PROTECTIVE_EXIT_CHECK_MS: "60000",
      AUTO_EXIT_ENABLED: "true",
    },
  },
  {
    id: "custom",
    label: "Custom",
    tagline: "Tune it yourself",
    detail: "Edit risk, timing, and size with plain-language controls",
  },
];

export const DEFAULT_PRESET_ID: SettingsPresetId = "balanced";

export function getBalancedPresetValues(): PresetConfig {
  return (
    SETTINGS_PRESET_VALUES.find((p) => p.id === "balanced")?.values || {
      STRATEGY: "medium",
    }
  );
}

/** Equity-trend defaults seeded when deploying a bStocks agent. */
export function getBstocksPresetValues(): PresetConfig {
  return {
    STRATEGY: "bstocks",
    MAX_DRAWDOWN_PCT: "18",
    MAX_DAILY_TRADES: "4",
    MAX_PORTFOLIO_TOKENS: "5",
    STOP_LOSS_PCT: "7",
    TAKE_PROFIT_PCT: "16",
    TRADE_INTERVAL_MS: "3600000",
    SIGNAL_REFRESH_MS: "300000",
    SLIPPAGE_TOLERANCE: "1",
    MIN_GAS_RESERVE_USD: "1.5",
    MAX_POSITION_SIZE_USD: "100",
    MIN_BUY_CONFIDENCE: "0.55",
    MIN_TRADE_AMOUNT_USD: "5",
    TRAILING_ACTIVATE_PCT: "6",
    TRAILING_GIVEBACK_PCT: "3",
    PROTECTIVE_EXIT_CHECK_MS: "60000",
    AUTO_EXIT_ENABLED: "true",
  };
}

const PRESET_MATCH_KEYS = [
  "STRATEGY",
  "MAX_DRAWDOWN_PCT",
  "MAX_DAILY_TRADES",
  "STOP_LOSS_PCT",
  "TAKE_PROFIT_PCT",
  "TRADE_INTERVAL_MS",
] as const;

/** Per-agent BNB Chain execution keys: tunable without switching to Custom preset. */
export const EXECUTION_CONFIG_KEYS = [
  "SLIPPAGE_TOLERANCE",
  "MIN_GAS_RESERVE_USD",
  "BSC_GAS_PRICE_GWEI",
  "BSC_SWAP_GAS_LIMIT",
] as const;

/** Infer which preset matches saved config (falls back to custom). */
export function detectPreset(config: Record<string, string | null>): SettingsPresetId {
  for (const preset of SETTINGS_PRESET_VALUES) {
    if (preset.id === "custom" || !preset.values) continue;
    const match = PRESET_MATCH_KEYS.every((key) => {
      const expected = preset.values![key];
      if (expected === undefined) return true;
      const actual = (config[key] ?? "").trim();
      if (!actual) {
        if (key === "STRATEGY") return expected === "medium";
        return true;
      }
      return actual === expected;
    });
    if (match) return preset.id;
  }
  return "custom";
}

export function msToMinutes(ms: string | undefined): string {
  const n = parseInt(ms || "", 10);
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(Math.round(n / 60_000));
}

export function minutesToMs(minutes: string): string {
  const n = parseFloat(minutes);
  if (!Number.isFinite(n) || n <= 0) return "3600000";
  return String(Math.round(n * 60_000));
}

export function msToSeconds(ms: string | undefined): string {
  const n = parseInt(ms || "", 10);
  if (!Number.isFinite(n) || n <= 0) return "60";
  return String(Math.round(n / 1000));
}

export function secondsToMs(seconds: string): string {
  const n = parseFloat(seconds);
  if (!Number.isFinite(n) || n <= 0) return "60000";
  return String(Math.round(n * 1000));
}

export function confidenceToPercent(conf: string | undefined): string {
  const n = parseFloat(conf || "");
  if (!Number.isFinite(n)) return "55";
  return String(Math.round(n * 100));
}

export function percentToConfidence(pct: string): string {
  const n = parseFloat(pct);
  if (!Number.isFinite(n) || n <= 0) return "0.55";
  return String(Math.min(1, Math.max(0.1, n / 100)));
}

export function formatPresetSummary(values: PresetConfig): string {
  const trades = values.MAX_DAILY_TRADES || "?";
  const stop = values.STOP_LOSS_PCT || "?";
  const tp = values.TAKE_PROFIT_PCT || "?";
  const dd = values.MAX_DRAWDOWN_PCT || "?";
  return `Up to ${trades} trades/day · stop ${stop}% · take-profit ${tp}% · max drawdown ${dd}%`;
}
