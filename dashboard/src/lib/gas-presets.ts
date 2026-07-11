/** User-friendly BSC gas speed presets (gwei only — gas limit always auto). */

export type GasSpeedPresetId = "cheapest" | "low" | "normal";

export interface GasSpeedPreset {
  id: GasSpeedPresetId;
  label: string;
  tagline: string;
  gwei: number;
}

/** Hardcoded: never pin a fixed gas limit from the UI — bridge estimates on-chain. */
export const AUTO_GAS_LIMIT = 0;

export const GAS_SPEED_PRESETS: GasSpeedPreset[] = [
  {
    id: "cheapest",
    label: "Cheapest",
    tagline: "0.07 gwei",
    gwei: 0.07,
  },
  {
    id: "low",
    label: "Low",
    tagline: "0.10 gwei",
    gwei: 0.1,
  },
  {
    id: "normal",
    label: "Normal",
    tagline: "0.15 gwei",
    gwei: 0.15,
  },
];

export const DEFAULT_GAS_SPEED: GasSpeedPresetId = "cheapest";

/** Typical on-chain gas used (for USD estimates only — not a tx limit). */
export const TYPICAL_APPROVE_GAS = 55_000;
export const TYPICAL_SWAP_GAS = 150_000;

const NORMAL = GAS_SPEED_PRESETS.find((p) => p.id === "normal")!;

export function gasSpeedEnv(id: GasSpeedPresetId): {
  BSC_GAS_PRICE_GWEI: string;
  BSC_SWAP_GAS_LIMIT: string;
} {
  const p = GAS_SPEED_PRESETS.find((x) => x.id === id)!;
  return {
    BSC_GAS_PRICE_GWEI: String(p.gwei),
    BSC_SWAP_GAS_LIMIT: String(AUTO_GAS_LIMIT),
  };
}

function sameNum(a: string, b: number): boolean {
  const n = parseFloat(a);
  return Number.isFinite(n) && Math.abs(n - b) < 1e-9;
}

/** Match saved env to a preset by gwei; empty/0 → cheapest. Limit is ignored (always auto). */
export function detectGasSpeedPreset(
  gwei?: string | null,
  _limit?: string | null
): GasSpeedPresetId {
  const g = (gwei ?? "").trim();
  if (!g || g === "0") return DEFAULT_GAS_SPEED;
  for (const p of GAS_SPEED_PRESETS) {
    if (sameNum(g, p.gwei)) return p.id;
  }
  // Legacy presets (0.05 / 0.2) → nearest new tier
  const n = parseFloat(g);
  if (Number.isFinite(n)) {
    if (n <= 0.085) return "cheapest";
    if (n <= 0.125) return "low";
    return "normal";
  }
  return DEFAULT_GAS_SPEED;
}

export function estimateGasCostUsd(
  gwei: number,
  gasUsed: number,
  bnbUsd: number
): number {
  return gasUsed * gwei * 1e-9 * bnbUsd;
}

export function formatGasUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export interface GasCostEstimate {
  approveUsd: number;
  swapUsd: number;
  relativeToNormal: number;
}

export function estimatePresetCosts(
  preset: GasSpeedPreset,
  bnbUsd: number
): GasCostEstimate {
  const approveUsd = estimateGasCostUsd(preset.gwei, TYPICAL_APPROVE_GAS, bnbUsd);
  const swapUsd = estimateGasCostUsd(preset.gwei, TYPICAL_SWAP_GAS, bnbUsd);
  const normalSwap = estimateGasCostUsd(NORMAL.gwei, TYPICAL_SWAP_GAS, bnbUsd);
  const relativeToNormal = normalSwap > 0 ? swapUsd / normalSwap : 1;
  return { approveUsd, swapUsd, relativeToNormal };
}

export function formatRelativeCost(ratio: number): string {
  if (Math.abs(ratio - 1) < 0.05) return "baseline";
  if (ratio < 1) {
    const times = 1 / ratio;
    if (times >= 10) return `${times.toFixed(0)}× cheaper`;
    return `${times.toFixed(1)}× cheaper`;
  }
  return `${ratio.toFixed(1)}× vs Normal`;
}
