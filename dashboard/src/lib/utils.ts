import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/**
 * Public/read-only deployment flag. When `NEXT_PUBLIC_READONLY=true` (e.g. on
 * agents.clipx.app) the dashboard renders as monitoring-only: all controls that
 * mutate the agent (start/stop, command/assistant, wallet sync, register,
 * resync, config) are hidden. Controls remain available on local/operator builds
 * where the flag is unset.
 */
export const READ_ONLY = process.env.NEXT_PUBLIC_READONLY === "true";

export function formatUsd(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Token quantity in trade history (not USD). */
export function formatTokenQty(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1000 ? 2 : 4,
  }).format(value);
}

/** Per-token price — extra decimals for sub-dollar assets. */
export function formatTradePrice(value: number): string {
  if (value <= 0) return formatUsd(0);
  if (value >= 1) return formatUsd(value, 2);
  if (value >= 0.01) return formatUsd(value, 4);
  return formatUsd(value, 6);
}

export function roundNum(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Display a metric value with sane precision (no float noise). */
export function formatMetric(value: number, decimals = 1): string {
  return roundNum(value, decimals).toFixed(decimals);
}

export function formatPct(value: number, decimals = 2): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${roundNum(value, decimals).toFixed(decimals)}%`;
}

export function formatRatio(current: number, max: number, unit = "", decimals = 1): string {
  return `${formatMetric(current, decimals)}${unit} / ${max}${unit}`;
}

export function formatNumber(value: number, decimals = 2): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(decimals);
}

export function shortenHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
